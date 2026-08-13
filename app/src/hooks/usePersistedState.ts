import { useEffect, useState } from 'react'

/**
 * State that survives a reload.
 *
 * Used for preferences the user has deliberately set — a setting that silently
 * resets to the default is a setting the user cannot trust, which matters when
 * the setting governs whether their money is allowed to cross a bridge.
 */
export function usePersistedState<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key)
      return stored === null ? fallback : (JSON.parse(stored) as T)
    } catch {
      return fallback
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Private browsing modes reject writes; the preference just will not persist.
    }
  }, [key, value])

  return [value, setValue]
}
