import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import type { CatalogProduct, Deal, DealInput } from '../types'

/** Promotions + the catalog they can target. Mutations re-fetch so every view stays in sync. */
export function useDeals(onChange?: () => void) {
  const [deals, setDeals] = useState<Deal[] | null>(null)
  const [catalog, setCatalog] = useState<{ products: CatalogProduct[]; categories: string[] }>({ products: [], categories: [] })
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [d, c] = await Promise.all([api.deals.list(), api.catalog()])
      setDeals(d); setCatalog(c); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    await fn()
    await load()
    onChange?.()
  }, [load, onChange])

  return {
    deals, catalog, error, reload: load,
    create: (d: DealInput) => run(() => api.deals.create(d)),
    update: (id: string, d: DealInput) => run(() => api.deals.update(id, d)),
    remove: (id: string) => run(() => api.deals.remove(id)),
  }
}

export const toInput = ({ id: _i, orgId: _o, createdAt: _c, updatedAt: _u, ...input }: Deal): DealInput => input
