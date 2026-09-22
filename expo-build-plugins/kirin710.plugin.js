/**
 * kirin710.plugin.js
 *
 * Expo config plugin que parchea el CMakeLists.txt de cui-llama.rn
 * durante el prebuild para compilar el .so optimizado para Cortex-A73.
 *
 * Cortex-A73 (Kirin 710) specs relevantes:
 *   - ARMv8-A base (SIN dotprod — eso es ARMv8.2-A → SIGILL en A73)
 *   - NEON 128-bit SIMD: SÍ
 *   - FP16 hardware nativo: NO (FP16 via NEON sí funciona)
 *   - L1 D-cache: 32KB, L2: 256KB/core, L3 shared: 1MB
 *   - Pipeline: 11 etapas, 2-wide decode, OoO
 */

const { withDangerousMod } = require('expo/config-plugins')
const fs = require('fs')
const path = require('path')

const MARKER = '# __KIRIN710_INJECTED__'

const K710_CMAKE_BLOCK = `
${MARKER}
# ── Kirin 710 / Cortex-A73 native optimization ──────────────────────────────
# Aplicado por expo-build-plugins/kirin710.plugin.js
# Cortex-A73 es ARMv8-A puro. NO soporta dotprod (ARMv8.2-A).
# Activar dotprod causa SIGILL (illegal instruction) en runtime.
if(ANDROID AND ANDROID_ABI STREQUAL "arm64-v8a")
    message(STATUS "")
    message(STATUS "===================================================")
    message(STATUS " Kirin 710 / Cortex-A73 optimization ACTIVE")
    message(STATUS " ABI: arm64-v8a | march: armv8-a | tune: cortex-a73")
    message(STATUS "===================================================")
    message(STATUS "")

    set(K710_C_FLAGS
        -march=armv8-a          # ARMv8-A base — seguro en A73
        -mtune=cortex-a73       # Scheduling optimizado para pipeline A73
        -O3                     # Máxima optimización
        -ffast-math             # Relajar precisión IEEE para más velocidad
        -fno-math-errno         # No setear errno en funciones math
        -fstrict-aliasing       # Permite más optimizaciones (safe con GGML)
        -funroll-loops          # Desenrollar loops (beneficia NEON)
        -fvectorize             # Vectorización automática via NEON
        -fprefetch-loop-arrays  # Prefetch explícito — crítico con L1 32KB del A73
        -fomit-frame-pointer    # Liberar registro extra
        -fno-stack-protector    # Quitar stack canary (release only)
        -ffunction-sections     # Una sección por función → --gc-sections elimina código muerto
        -fdata-sections         # Una sección por variable → --gc-sections
    )
    string(JOIN " " K710_FLAGS_STR \${K710_C_FLAGS})

    # Linker flags: eliminar código muerto + optimizar relocaciones
    set(K710_LINKER_FLAGS "-Wl,--gc-sections -Wl,-O1 -Wl,--as-needed")

    # Aplicar a C y C++ — FORCE para sobreescribir cualquier flag previo
    set(CMAKE_C_FLAGS   "\${CMAKE_C_FLAGS} \${K710_FLAGS_STR}"   CACHE STRING "" FORCE)
    set(CMAKE_CXX_FLAGS "\${CMAKE_CXX_FLAGS} \${K710_FLAGS_STR}" CACHE STRING "" FORCE)
    set(CMAKE_EXE_LINKER_FLAGS    "\${CMAKE_EXE_LINKER_FLAGS} \${K710_LINKER_FLAGS}"    CACHE STRING "" FORCE)
    set(CMAKE_SHARED_LINKER_FLAGS "\${CMAKE_SHARED_LINKER_FLAGS} \${K710_LINKER_FLAGS}" CACHE STRING "" FORCE)

    # ── Deshabilitar dotprod EXPLÍCITAMENTE ─────────────────────────────────
    # El compilador NDK *soporta* el flag aunque el target no lo tenga.
    # GGML puede habilitarlo si no lo forzamos OFF. Resultado: SIGILL en A73.
    set(GGML_DOTPROD        OFF CACHE BOOL "A73 no tiene dotprod" FORCE)
    set(GGML_ARM_DOTPROD    OFF CACHE BOOL "" FORCE)
    # Variantes según versión de llama.cpp
    set(GGML_USE_LLAMAFILE  OFF CACHE BOOL "" FORCE)

    # ── Habilitar NEON explícitamente ───────────────────────────────────────
    # A73 tiene NEON 128-bit. GGML lo detecta en aarch64 pero es mejor forzarlo.
    set(GGML_NEON    ON  CACHE BOOL "A73 tiene NEON" FORCE)
    # FP16 via NEON (no es hardware FP16 nativo, pero GGML lo usa via intrínsecos NEON)
    set(GGML_FP16_VA ON  CACHE BOOL "FP16 vectorizado via NEON en A73" FORCE)

    # ── Deshabilitar auto-detección de arquitectura del host ────────────────
    # Evita que llama.cpp detecte el host de compilación (x86_64) y mande
    # flags incompatibles con el target arm64.
    set(LLAMA_NATIVE OFF CACHE BOOL "No auto-detectar CPU del host" FORCE)

    # ── Deshabilitar backends no disponibles en Kirin 710 ───────────────────
    set(GGML_METAL   OFF CACHE BOOL "" FORCE)  # Solo iOS
    set(GGML_CUDA    OFF CACHE BOOL "" FORCE)  # No hay CUDA
    # Vulkan: Kirin 710 / Mali-G51 MP4 NO tiene Vulkan Compute funcional para GGML.
    # Deshabilitarlo en compile-time elimina el warning "ggml_vk_create_instance:
    # No Vulkan devices found" que aparece en cada arranque aunque disable_log=true.
    set(GGML_VULKAN              OFF CACHE BOOL "Kirin 710 no tiene Vulkan Compute" FORCE)
    set(GGML_VULKAN_DEBUG        OFF CACHE BOOL "" FORCE)
    set(GGML_VULKAN_MEMORY_DEBUG OFF CACHE BOOL "" FORCE)
    # F16C es extensión x86 (SSE). En ARM no aplica, pero forzarlo OFF
    # evita posibles ramas de código que GGML tiene para F16C.
    set(GGML_F16C    OFF CACHE BOOL "F16C es x86, no aplica en ARM" FORCE)
    # OpenMP en Android/NDK genera overhead sin beneficio real para inferencia.
    # llama.cpp usa sus propios threads; mezclar con OpenMP causa contención.
    set(GGML_OPENMP  OFF CACHE BOOL "Usar threads propios de llama.cpp" FORCE)
    # OpenCL: dejar en runtime vía force_device (el .so genérico ya lo incluye)
endif()
# ── Fin Kirin 710 ────────────────────────────────────────────────────────────
`

function patchCMakeLists(projectRoot) {
    // Buscar CMakeLists en cui-llama.rn
    const candidates = [
        // cui-llama.rn >= 1.12: CMakeLists está en android/rnllama/CMakeLists.txt
        path.join(projectRoot, 'node_modules', 'cui-llama.rn', 'android', 'rnllama', 'CMakeLists.txt'),
        // llama.rn también puede tenerlo en rnllama/
        path.join(projectRoot, 'node_modules', 'llama.rn', 'android', 'rnllama', 'CMakeLists.txt'),
        // Fallback: raíz de android/ (versiones antiguas)
        path.join(projectRoot, 'node_modules', 'cui-llama.rn', 'android', 'CMakeLists.txt'),
        path.join(projectRoot, 'node_modules', 'llama.rn', 'android', 'CMakeLists.txt'),
    ]

    const cmakePath = candidates.find(fs.existsSync)

    if (!cmakePath) {
        console.warn('[kirin710] ADVERTENCIA: CMakeLists.txt no encontrado.')
        console.warn('[kirin710] Paths probados:', candidates)
        return false
    }

    let content = fs.readFileSync(cmakePath, 'utf8')

    // Idempotente: no aplicar dos veces
    if (content.includes(MARKER)) {
        console.log('[kirin710] CMakeLists.txt ya está parcheado, saltando.')
        return true
    }

    // Insertar después de project() o cmake_minimum_required()
    // Necesita estar temprano para que las variables CACHE funcionen
    const insertionPatterns = [
        /project\s*\([^)]+\)\s*/,
        /cmake_minimum_required\s*\([^)]+\)\s*/,
    ]

    let inserted = false
    for (const pattern of insertionPatterns) {
        const match = content.match(pattern)
        if (match) {
            content = content.replace(match[0], match[0] + K710_CMAKE_BLOCK)
            inserted = true
            break
        }
    }

    if (!inserted) {
        // Fallback: insertar al principio
        content = K710_CMAKE_BLOCK + '\n' + content
    }

    fs.writeFileSync(cmakePath, content)
    console.log('[kirin710] CMakeLists.txt parcheado:', cmakePath)
    console.log('[kirin710] Flags: -march=armv8-a -mtune=cortex-a73 -O3 -ffast-math')
    console.log('[kirin710] Extras: -fprefetch-loop-arrays -ffunction-sections -fdata-sections')
    console.log('[kirin710] Linker: --gc-sections -O1 --as-needed')
    console.log('[kirin710] GGML_DOTPROD=OFF GGML_NEON=ON GGML_FP16_VA=ON LLAMA_NATIVE=OFF')
    return true
}

module.exports = function withKirin710(config, options = {}) {
    const { enabled = true } = options

    if (!enabled) {
        return config
    }

    return withDangerousMod(config, [
        'android',
        async (c) => {
            patchCMakeLists(c.modRequest.projectRoot)
            return c
        },
    ])
          }
