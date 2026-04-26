import { Navigate } from 'react-router-dom'
import { useAuth } from './AuthProvider'

function ProtectedRoute({ children }) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen bg-navy text-white flex items-center justify-center font-body">
        <p className="text-gold">Loading…</p>
      </div>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return children
}

export default ProtectedRoute
