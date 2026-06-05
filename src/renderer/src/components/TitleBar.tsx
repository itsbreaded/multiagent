export function TitleBar(): JSX.Element {
  return (
    <div
      style={{
        height: 38,
        backgroundColor: '#141517',
        borderBottom: '1px solid #2a2b2e',
        display: 'flex',
        alignItems: 'center',
        paddingLeft: 16,
        paddingRight: 16,
        flexShrink: 0,
        // Make the entire title bar draggable on macOS
        WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion']
      } as React.CSSProperties}
    >
      <span
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: '#8b8d91',
          userSelect: 'none',
          WebkitUserSelect: 'none'
        }}
      >
        MultiAgent
      </span>
    </div>
  )
}
