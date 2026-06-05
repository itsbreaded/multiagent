import { usePanesStore } from '../store/panes'

export function usePanes() {
  const store = usePanesStore()
  return {
    activeTab: store.activeTab(),
    focusedPane: store.getFocusedPane(),
    splitVertical: () => {
      const pane = store.getFocusedPane()
      if (pane) store.splitPane(pane.id, 'vertical')
    },
    splitHorizontal: () => {
      const pane = store.getFocusedPane()
      if (pane) store.splitPane(pane.id, 'horizontal')
    },
    closePane: () => {
      const pane = store.getFocusedPane()
      if (pane) store.closePane(pane.id)
    },
    zoom: () => {
      const pane = store.getFocusedPane()
      if (pane) store.zoomPane(pane.id)
    },
  }
}
