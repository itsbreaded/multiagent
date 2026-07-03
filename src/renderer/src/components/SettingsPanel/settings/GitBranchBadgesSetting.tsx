import { useSettingsStore } from '../../../store/settings'
import { checkStyle, SettingControlRow } from './shared'
export function GitBranchBadgesSetting(): JSX.Element { const value=useSettingsStore(s=>s.showGitBranchBadges), setValue=useSettingsStore(s=>s.setShowGitBranchBadges); return <SettingControlRow title="Git branch badges" description="Show the current branch beside tab default directories and pane directories."><label style={checkStyle}><input type="checkbox" checked={value} onChange={e=>setValue(e.target.checked)}/>Enabled</label></SettingControlRow> }
