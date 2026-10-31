import { QueryClientProvider } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from './auth/AuthProvider'
import AuthCallbackPage from './auth/AuthCallbackPage'
import { AuthLoadingScreen } from './auth/AuthLoading'
import LoginPage from './auth/LoginPage'
import { AppShell } from './components/AppShell'
import { AppErrorBoundary } from './components/errors/AppErrorBoundary'
import { RootErrorFallback } from './components/errors/ErrorFallbacks'
import { PublicLayout } from './components/PublicLayout'
import { queryClient } from './lib/queryClient'
import { QueryCacheReset } from './profile/QueryCacheReset'
import JoinProjectPage from './projects/JoinProjectPage'
import ProjectMembersPage from './projects/ProjectMembersPage'
import ProjectPage from './projects/ProjectPage'
import ProjectsPage from './projects/ProjectsPage'
import NotFoundPage from './routes/NotFoundPage'
import {
  BoardPage,
  FeedbackPage,
  SummaryPage,
  UploadPage,
} from './routes/Placeholders'
import ProtectedRoute from './routes/ProtectedRoute'

/**
 * Routes are only mounted once auth has settled. This is what keeps the
 * loading view from ever flashing the shell, the login form, or a placeholder.
 */
function AppRoutes() {
  const { status } = useAuth()

  if (status === 'loading') {
    return <AuthLoadingScreen />
  }

  return (
    <Routes>
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route element={<PublicLayout />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
      </Route>
      <Route element={<ProtectedRoute />}>
        <Route element={<AppShell />}>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route
            path="/projects/:id/members"
            element={<ProjectMembersPage />}
          />
          <Route path="/join/:token" element={<JoinProjectPage />} />
          <Route path="/cycles/:id/feedback" element={<FeedbackPage />} />
          <Route path="/cycles/:id/board" element={<BoardPage />} />
          <Route path="/cycles/:id/upload" element={<UploadPage />} />
          <Route path="/cycles/:id/summary" element={<SummaryPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  )
}

function App() {
  return (
    <AppErrorBoundary fallback={() => <RootErrorFallback />}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <QueryCacheReset />
          <Toaster position="top-right" theme="light" />
          <AppRoutes />
        </AuthProvider>
      </QueryClientProvider>
    </AppErrorBoundary>
  )
}

export default App
