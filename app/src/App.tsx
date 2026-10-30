import { Navigate, Route, Routes } from 'react-router-dom'
import BackendStatus from './BackendStatus'
import { AuthProvider } from './auth/AuthProvider'
import AuthCallbackPage from './auth/AuthCallbackPage'
import LoginPage from './auth/LoginPage'
import ProjectsPage from './projects/ProjectsPage'
import ProtectedRoute from './routes/ProtectedRoute'

function App() {
  return (
    <AuthProvider>
      <main>
        <h1>Weekly Feedback Tool</h1>
        <BackendStatus />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/projects" element={<ProjectsPage />} />
          </Route>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </main>
    </AuthProvider>
  )
}

export default App
