import Toast from 'react-native-simple-toast'
import { create } from 'zustand'

// No persist - logs son solo en memoria. Elimina escrituras a MMKV por cada log.
// Reduces RAM: 50 entries max, sin console.* (cero I/O en JS thread).
const MAX_LOG_LENGTH = 50

export enum LogLevel {
    INFO,
    WARN,
    ERROR,
    DEBUG,
}

type LogEntry = {
    timestamp: string
    message: string
    level: LogLevel
}

type LogStateProps = {
    logs: LogEntry[]
    addLog: (entry: LogEntry) => void
    flushLogs: () => void
}

export namespace Logger {
    // Flag: durante inferencia solo escribimos ERRORs al estado para no bloquear JS thread
    let _inferencing = false
    export const setInferencing = (v: boolean) => { _inferencing = v }

    export const useLoggerStore = create<LogStateProps>()((set, get) => ({
        logs: [],
        addLog: (entry) => {
            // Durante inferencia: silenciar INFO/DEBUG/WARN para no triggerar re-renders
            if (_inferencing && entry.level !== LogLevel.ERROR) return
            const prev = get().logs
            const newlogs = prev.length >= MAX_LOG_LENGTH
                ? [...prev.slice(1), entry]
                : [...prev, entry]
            set({ logs: newlogs })
        },
        flushLogs: () => set({ logs: [] }),
    }))

    export const LevelName: Record<LogLevel, string> = {
        [LogLevel.INFO]: 'INFO',
        [LogLevel.WARN]: 'WARN',
        [LogLevel.ERROR]: 'ERROR',
        [LogLevel.DEBUG]: 'DEBUG',
    }

    const toastTime = Toast.SHORT

    const createLog = (data: string, level: LogLevel): LogEntry => ({
        timestamp: new Date().toLocaleTimeString(),
        message: data,
        level,
    })

    export const info = (data: string) => {
        if (_inferencing) return
        useLoggerStore.getState().addLog(createLog(data, LogLevel.INFO))
    }

    export const infoToast = (data: string) => {
        info(data)
        Toast.show(data, toastTime)
    }

    export const warn = (data: string) => {
        if (_inferencing) return
        useLoggerStore.getState().addLog(createLog(data, LogLevel.WARN))
    }

    export const warnToast = (data: string) => {
        warn(data)
        Toast.show(data, toastTime)
    }

    export const error = (data: string) => {
        // Errores siempre se guardan, incluso durante inferencia
        useLoggerStore.getState().addLog(createLog(data, LogLevel.ERROR))
    }

    export const errorToast = (data: string, extra?: string) => {
        error(extra ? `${data}\n→ ${extra}` : data)
        Toast.show(data, toastTime)
    }

    export const debug = (data: string) => {
        if (_inferencing) return
        useLoggerStore.getState().addLog(createLog(data, LogLevel.DEBUG))
    }
}
