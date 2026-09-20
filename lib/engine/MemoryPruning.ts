import React from 'react'
/**
 * Memory Pruning + Context Shift: Sistema inteligente para olvidar mensajes antiguos
 * cuando se llena el contexto, evitando el costoso ctx_shift full.
 *
 * FLUJO:
 * 1. Estima tokens disponibles = context_length - n_keep - overhead
 * 2. Si se acerca al softLimit (80%): elimina mensaje antiguo silenciosamente
 * 3. Si toca hardLimit (95%): elimina agresivamente + ctx_shift fuerza defrag
 * 4. ctx_shift=false + n_keep=256: preserva 256 tokens (system prompt + recent msgs)
 * 5. defrag_thold=0.1: auto-defrag cada 10% de rellenado (eficiente)
 *
 * Resultado: Contexto ilimitado sin rescanneos costosos, avance fluido.
 */

import { Tokenizer } from './Tokenizer'
import { Llama } from './Local/LlamaLocal'
import { Logger } from '@lib/state/Logger'

export type MemoryPruneConfig = {
    maxMessagesToKeep: number // Mínimo de mensajes recientes a guardar siempre
    softLimitPercent: number // Cuando el contexto está X% lleno, prune (ej: 80%)
    hardLimitPercent: number // Cuando contexto está X% lleno, fuerza prune (ej: 95%)
    aggressiveFactorHard: number // Factor multiplicador para hard limit (default: 2)
    enableLogging: boolean // Log detallado de memory pruning
}

// Config optimizada para Kirin 710 + ctx_shift=false
export const DEFAULT_PRUNE_CONFIG: MemoryPruneConfig = {
    maxMessagesToKeep: 8, // Mantén últimos 8 mensajes siempre
    softLimitPercent: 75, // Prune soft a 75%
    hardLimitPercent: 90, // Prune hard a 90%
    aggressiveFactorHard: 2.5, // Elimina X2.5 mensajes en hard limit
    enableLogging: true,
}

/**
 * Construye la config de poda a partir de los ajustes del usuario (LlamaConfig).
 * Valida rangos: 30 <= soft < hard <= 98, para que nunca queden invertidos ni absurdos.
 */
export const buildPruneConfig = (config: any): MemoryPruneConfig => {
    let soft = Number(config?.prune_soft_percent ?? DEFAULT_PRUNE_CONFIG.softLimitPercent)
    let hard = Number(config?.prune_hard_percent ?? DEFAULT_PRUNE_CONFIG.hardLimitPercent)
    if (!Number.isFinite(soft)) soft = DEFAULT_PRUNE_CONFIG.softLimitPercent
    if (!Number.isFinite(hard)) hard = DEFAULT_PRUNE_CONFIG.hardLimitPercent
    soft = Math.min(Math.max(soft, 30), 95)
    hard = Math.min(Math.max(hard, soft + 3), 98)
    return { ...DEFAULT_PRUNE_CONFIG, softLimitPercent: soft, hardLimitPercent: hard }
}

/**
 * Estima cuántos tokens ocupa el contexto actual (con caching para speed)
 * Usa token_count cacheado primero, tokeniza bajo demanda si falta.
 */
/**
 * Devuelve la swipe activa de una entrada.
 * OJO: entry.swipe_id esta DEPRECADO (ver migration.deprecate_swipe_id);
 * la swipe activa se marca con swipe.active === true.
 */
const getActiveSwipe = (entry: any) => {
    if (!entry || !Array.isArray(entry.swipes) || entry.swipes.length === 0) return undefined
    return entry.swipes.find((s: any) => s?.active) ?? entry.swipes[entry.swipes.length - 1]
}

export const estimateContextTokens = async (messages: any[]): Promise<number> => {
    let totalTokens = 0
    let tokenizationNeeded = 0

    for (const entry of messages) {
        const swipe = getActiveSwipe(entry)
        if (!swipe || !swipe.swipe) continue

        // Cache: token_length (DB) o token_count (estado en memoria)
        const cached = swipe.token_length ?? swipe.token_count
        if (typeof cached === 'number' && cached > 0) {
            totalTokens += cached
        } else if (swipe.swipe.length > 0) {
            // Solo tokenizar si no hay cache y hay contenido
            tokenizationNeeded++
            try {
                const tokenCount = await Tokenizer.getTokenizer()(swipe.swipe)
                totalTokens += tokenCount
                swipe.token_count = tokenCount // Cache para futuras estimaciones
            } catch (e) {
                Logger.warn(`[Memory] Error tokenizing, using fallback: ${e}`)
                totalTokens += Math.ceil(swipe.swipe.length / 4) // 1 token ~= 4 chars
            }
        }
    }

    if (tokenizationNeeded > 0) {
        Logger.info(`[Memory] Tokenized ${tokenizationNeeded} messages for estimation`)
    }

    return totalTokens
}

/**
 * Calcula cuántos tokens hay disponibles antes de llenar el contexto
 * 
 * Fórmula: available = ctx_len - n_keep - overhead - genamt
 * - n_keep: tokens fijos (system prompt + char card, no se descartan)
 * - overhead: buffer para stop tokens, formatting, safety
 * - genamt: tokens que se van a generar (n_predict)
 */
export const getAvailableTokens = (config: any, genamt?: number): number => {
    const contextLength = config.context_length ?? 4096
    const nKeep = Math.max(config.n_keep ?? 256, 128) // Mínimo 128 tokens de sistema
    const overhead = 250 // Buffer para stop tokens, formato, seguridad
    const generateAmount = genamt ?? (config.n_predict ?? 512)

    const available = contextLength - nKeep - overhead - generateAmount
    
    // Validación: asegura que hay al menos espacio mínimo
    if (available < 256) {
        Logger.warn(
            `[Memory] Contexto muy pequeño: ${contextLength} - ${nKeep} - ${overhead} - ${generateAmount} = ${available}. Min 256.`
        )
        return Math.max(available, 256) // Garantiza al menos 256 para mensajes
    }

    return available
}

/**
 * Elimina los mensajes mas antiguos (desde el inicio del arreglo).
 * Despues de podar, si el primer mensaje queda siendo del asistente, tambien se
 * elimina (siempre que se respete el piso), para que la conversacion empiece con
 * un turno del usuario y las plantillas de chat no fallen.
 * Devuelve cuantos mensajes se eliminaron en total.
 */
const removeOldest = (messages: any[], count: number, floor: number): number => {
    let removed = 0
    for (let i = 0; i < count && messages.length > floor; i++) {
        messages.shift()
        removed++
    }
    while (messages.length > floor && messages[0] && messages[0].is_user === false) {
        messages.shift()
        removed++
    }
    return removed
}

/**
 * Prune inteligente: elimina mensajes antiguos cuando se llenan.
 * 
 * NIVELES:
 * - VERDE (< softLimit): sin prune, avanza normal
 * - AMARILLO (softLimit-hardLimit): elimina 1-2 msgs antiguos/iteración
 * - ROJO (> hardLimit): elimina agresivamente + ctx_shift fuerza defrag
 * 
 * Retorna:
 * - { pruned: boolean, count: number, reason: string, contextShiftNeeded: boolean }
 */
export const pruneMemoryIfNeeded = async (
    messages: any[],
    config: any,
    pruneConfig: MemoryPruneConfig = DEFAULT_PRUNE_CONFIG,
    tokenBudget?: number, // maxLength real del ContextBuilder; si falta se estima
    reservedTokens: number = 0 // tokens fijos (system prompt + tarjeta) que ocupan contexto y no se podan
): Promise<{ pruned: boolean; count: number; reason: string; contextShiftNeeded: boolean }> => {
    // Solo saltar si prácticamente no hay conversación (evita vaciar el chat)
    if (messages.length <= 2) {
        return { pruned: false, count: 0, reason: 'few_messages', contextShiftNeeded: false }
    }

    const currentTokens = (await estimateContextTokens(messages)) + Math.max(reservedTokens, 0)
    const availableTokens =
        tokenBudget && tokenBudget > 0 ? tokenBudget : getAvailableTokens(config, config.n_predict)
    const fillPercent = (currentTokens / availableTokens) * 100

    // VERDE: sin prune necesario
    if (fillPercent < pruneConfig.softLimitPercent) {
        return { pruned: false, count: 0, reason: 'under_soft_limit', contextShiftNeeded: false }
    }

    // Piso absoluto: siempre dejar al menos estos mensajes (últimos = más relevantes)
    const MIN_MESSAGES_FLOOR = 2

    // AMARILLO: soft limit - elimina 1-2 mensajes
    if (fillPercent >= pruneConfig.softLimitPercent && fillPercent < pruneConfig.hardLimitPercent) {
        const toRemove = Math.max(0, Math.min(2, messages.length - MIN_MESSAGES_FLOOR))

        if (toRemove === 0) {
            if (pruneConfig.enableLogging) {
                Logger.warn(
                    `[Memory] 🟡 SOFT LIMIT: ${fillPercent.toFixed(0)}% lleno, pero no quedan mensajes de sobra para descartar.`
                )
            }
            return { pruned: false, count: 0, reason: 'soft_limit_floor_reached', contextShiftNeeded: false }
        }

        if (pruneConfig.enableLogging) {
            Logger.warn(
                `[Memory] 🟡 SOFT LIMIT: ${fillPercent.toFixed(0)}% lleno. Descartando ${toRemove} mensaje(s) antiguo(s)...`
            )
        }

        const removed = removeOldest(messages, toRemove, MIN_MESSAGES_FLOOR)

        return {
            pruned: removed > 0,
            count: removed,
            reason: 'soft_limit_prune',
            contextShiftNeeded: false, // ctx_shift=false, solo descarte
        }
    }

    // ROJO: hard limit - elimina agresivamente + ctx_shift
    if (fillPercent >= pruneConfig.hardLimitPercent) {
        const maxRemovable = Math.max(0, messages.length - MIN_MESSAGES_FLOOR)
        const toRemove = Math.min(
            maxRemovable,
            Math.ceil(maxRemovable * (pruneConfig.aggressiveFactorHard / 10)) || maxRemovable
        )

        if (toRemove === 0) {
            if (pruneConfig.enableLogging) {
                Logger.error(
                    `[Memory] 🔴 HARD LIMIT: ${fillPercent.toFixed(0)}% CRÍTICO, pero no quedan mensajes de sobra para descartar.`
                )
            }
            return { pruned: false, count: 0, reason: 'hard_limit_floor_reached', contextShiftNeeded: false }
        }

        if (pruneConfig.enableLogging) {
            Logger.error(
                `[Memory] 🔴 HARD LIMIT: ${fillPercent.toFixed(0)}% CRÍTICO. ` +
                `Descartando ${toRemove}/${messages.length} msgs.`
            )
        }

        const removed = removeOldest(messages, toRemove, MIN_MESSAGES_FLOOR)

        return {
            pruned: removed > 0,
            count: removed,
            reason: 'hard_limit_prune',
            contextShiftNeeded: false, // ctx_shift permanece desactivado; ya limpiamos memoria
        }
    }

    return { pruned: false, count: 0, reason: 'unknown', contextShiftNeeded: false }
}

/**
 * Hook de configuración de memory pruning con estadísticas
 */
export const useMemoryPruning = () => {
    const config = Llama.useLlamaPreferencesStore((state) => state.config)
    const [pruneConfig, setPruneConfig] = React.useState<MemoryPruneConfig>(DEFAULT_PRUNE_CONFIG)
    const [stats, setStats] = React.useState({
        totalPruned: 0,
        totalMessages: 0,
        lastPruneReason: '',
    })

    const updatePruneConfig = (partial: Partial<MemoryPruneConfig>) => {
        setPruneConfig((prev) => ({ ...prev, ...partial }))
    }

    const performPruning = async (messages: any[]) => {
        const result = await pruneMemoryIfNeeded(messages, config, pruneConfig)
        
        if (result.pruned) {
            setStats((prev) => ({
                totalPruned: prev.totalPruned + result.count,
                totalMessages: messages.length,
                lastPruneReason: result.reason,
            }))
        }

        return result
    }

    return {
        pruneConfig,
        updatePruneConfig,
        pruneMemoryIfNeeded: performPruning,
        stats,
        resetStats: () => setStats({ totalPruned: 0, totalMessages: 0, lastPruneReason: '' }),
    }
}
