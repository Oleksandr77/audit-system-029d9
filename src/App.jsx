import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import { sections, companies, statusOptions } from './lib/data'

function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) throw error
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  return (
    <div className="auth-container">
      <div className="auth-box">
        <h1>Audit System</h1>
        <form onSubmit={handleSubmit}>
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>{loading ? '...' : 'Login'}</button>
        </form>
      </div>
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [statuses, setStatuses] = useState({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    supabase.auth.onAuthStateChange((_, session) => setSession(session))
  }, [])

  if (loading) return <div>Loading...</div>
  if (!session) return <Auth />

  return (
    <div className="app">
      <header>
        <h1>Audit System</h1>
        <button onClick={() => supabase.auth.signOut()}>Logout</button>
      </header>
      <main>
        <p>Welcome! System is ready.</p>
      </main>
    </div>
  )
}