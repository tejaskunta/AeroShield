import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/shell/AppShell'
import { MissionControl } from '@/screens/MissionControl'
import { DetectionCenter } from '@/screens/DetectionCenter'
import { Analytics } from '@/screens/Analytics'
import { SafetyCopilot } from '@/screens/SafetyCopilot'
import { MissionReports } from '@/screens/MissionReports'
import { MissionStart } from '@/screens/MissionStart'

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/start" replace />} />
          <Route path="/start" element={<MissionStart />} />
          <Route path="/mission" element={<MissionControl />} />
          <Route path="/detections" element={<DetectionCenter />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/copilot" element={<SafetyCopilot />} />
          <Route path="/reports" element={<MissionReports />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
