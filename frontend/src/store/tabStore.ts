import { create } from 'zustand'
import type { Tab } from '@/types'

const MAX_TABS = 10
const DEFAULT_TABS: Tab[] = [
  { id: 'home', title: 'Home', path: '/', icon: 'Home', closeable: false, pinned: false },
]

interface TabStore {
  tabs: Tab[]
  activeTabId: string
  toast: string | null
  openTab: (tab: Omit<Tab, 'id' | 'closeable' | 'pinned'>) => void
  closeTab: (id: string) => void
  setActiveTab: (id: string) => void
  togglePin: (id: string) => void
  moveTab: (fromIndex: number, toIndex: number) => void
  closeOthers: (id: string) => void
  closeAll: () => void
  clearToast: () => void
}

export const useTabStore = create<TabStore>((set, get) => ({
  tabs: DEFAULT_TABS,
  activeTabId: 'home',
  toast: null,

  openTab: (tab) => {
    const { tabs } = get()
    const existing = tabs.find((t) => t.path === tab.path)
    if (existing) {
      set({ activeTabId: existing.id })
      return
    }

    const pinnedCount = tabs.filter((t) => t.pinned).length
    if (pinnedCount >= MAX_TABS) {
      set({ toast: 'Maximum 10 pinned tabs. Unpin a tab to open new ones.' })
      setTimeout(() => get().clearToast(), 3000)
      return
    }

    // Auto close oldest unpinned tab if over limit
    let newTabs = [...tabs]
    if (newTabs.length >= MAX_TABS) {
      const unpinnedCloseable = newTabs.filter((t) => t.closeable && !t.pinned)
      if (unpinnedCloseable.length > 0) {
        const toRemove = unpinnedCloseable[0]
        newTabs = newTabs.filter((t) => t.id !== toRemove.id)
      } else {
        set({ toast: 'All tabs are pinned. Unpin a tab to open new ones.' })
        setTimeout(() => get().clearToast(), 3000)
        return
      }
    }

    // Auto-close any new-tab pages when opening a real page
    if (!tab.path.startsWith('/new-tab')) {
      newTabs = newTabs.filter((t) => !t.path.startsWith('/new-tab'))
    }

    const id = tab.path.replace(/\//g, '-').replace(/^-/, '') || 'home'
    const newTab: Tab = { ...tab, id, closeable: true, pinned: false }
    set({ tabs: [...newTabs, newTab], activeTabId: id })

    // Track recent tabs in localStorage
    if (!tab.path.startsWith('/new-tab')) {
      try {
        const recent: { title: string; path: string; time: number }[] = JSON.parse(localStorage.getItem('mefai_recent_tabs') || '[]')
        const filtered = recent.filter(r => r.path !== tab.path)
        filtered.unshift({ title: tab.title, path: tab.path, time: Date.now() })
        localStorage.setItem('mefai_recent_tabs', JSON.stringify(filtered.slice(0, 12)))
      } catch {}
    }
  },

  closeTab: (id) => {
    const { tabs, activeTabId } = get()
    const tab = tabs.find((t) => t.id === id)
    if (!tab || !tab.closeable) return

    if (tab.pinned) {
      set({ toast: 'This tab is pinned. Unpin it first to close.' })
      setTimeout(() => get().clearToast(), 3000)
      return
    }

    const filtered = tabs.filter((t) => t.id !== id)
    const newActive =
      activeTabId === id
        ? filtered[filtered.length - 1]?.id || 'home'
        : activeTabId
    set({ tabs: filtered, activeTabId: newActive })
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  togglePin: (id) => {
    const { tabs } = get()
    const tab = tabs.find((t) => t.id === id)
    if (!tab || !tab.closeable) return

    if (!tab.pinned) {
      const pinnedCount = tabs.filter((t) => t.pinned).length
      if (pinnedCount >= MAX_TABS) {
        set({ toast: 'Maximum 10 pinned tabs reached.' })
        setTimeout(() => get().clearToast(), 3000)
        return
      }
    }

    set({
      tabs: tabs.map((t) =>
        t.id === id ? { ...t, pinned: !t.pinned } : t
      ),
    })
  },

  moveTab: (fromIndex, toIndex) => {
    const { tabs } = get()
    if (fromIndex === toIndex) return
    const newTabs = [...tabs]
    const [moved] = newTabs.splice(fromIndex, 1)
    newTabs.splice(toIndex, 0, moved)
    set({ tabs: newTabs })
  },

  closeOthers: (id) => {
    const { tabs } = get()
    const kept = tabs.filter((t) => t.id === id || !t.closeable || t.pinned)
    set({ tabs: kept, activeTabId: id })
  },

  closeAll: () => {
    const { tabs } = get()
    const kept = tabs.filter((t) => !t.closeable || t.pinned)
    set({ tabs: kept, activeTabId: kept[kept.length - 1]?.id || 'home' })
  },

  clearToast: () => set({ toast: null }),
}))
