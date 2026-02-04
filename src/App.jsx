import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'

// Role labels / Назви ролей
const ROLES = {
  super_admin: { uk: 'Супер Адмін', pl: 'Super Admin' },
  lawyer_admin: { uk: 'Юрист Адмін', pl: 'Prawnik Admin' },
  lawyer_auditor: { uk: 'Юрист Аудитор', pl: 'Prawnik Audytor' },
  user_cat1: { uk: 'Користувач', pl: 'Użytkownik' }
}

const STATUS_OPTIONS = [
  { value: 'pending', uk: '⏳ Очікує', pl: '⏳ Oczekuje' },
  { value: 'in_progress', uk: '🔄 В роботі', pl: '🔄 W trakcie' },
  { value: 'done', uk: '✅ Готово', pl: '✅ Gotowe' },
  { value: 'missing', uk: '❌ Відсутній', pl: '❌ Brak' }
]

// Auth Component
function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError('')
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
        <p className="auth-subtitle">Система управління документами / System zarządzania dokumentami</p>
        <form onSubmit={handleSubmit}>
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input type="password" placeholder="Пароль / Hasło" value={password} onChange={e => setPassword(e.target.value)} required />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>{loading ? '...' : 'Увійти / Zaloguj'}</button>
        </form>
      </div>
    </div>
  )
}

// User Management Component (for Super Admin)
function UserManagement({ currentUser, onClose }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [newUser, setNewUser] = useState({ email: '', password: '', full_name: '', role: 'user_cat1' })
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    loadUsers()
  }, [])

  const loadUsers = async () => {
    const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
    setUsers(data || [])
    setLoading(false)
  }

  const createUser = async (e) => {
    e.preventDefault()
    setCreating(true)
    try {
      const { data, error } = await supabase.auth.admin.createUser({
        email: newUser.email,
        password: newUser.password,
        email_confirm: true,
        user_metadata: { full_name: newUser.full_name, role: newUser.role }
      })
      if (error) throw error
      
      // Update profile with correct role
      await supabase.from('profiles').update({ 
        full_name: newUser.full_name, 
        role: newUser.role 
      }).eq('id', data.user.id)
      
      setNewUser({ email: '', password: '', full_name: '', role: 'user_cat1' })
      loadUsers()
      alert('Користувача створено! / Użytkownik utworzony!')
    } catch (err) {
      alert('Помилка: ' + err.message)
    }
    setCreating(false)
  }

  const updateUserRole = async (userId, newRole) => {
    await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    loadUsers()
  }

  const toggleUserActive = async (userId, isActive) => {
    await supabase.from('profiles').update({ is_active: !isActive }).eq('id', userId)
    loadUsers()
  }

  if (loading) return <div className="loading">Завантаження... / Ładowanie...</div>

  return (
    <div className="modal-overlay">
      <div className="modal user-management">
        <div className="modal-header">
          <h2>👥 Управління користувачами / Zarządzanie użytkownikami</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        
        <div className="modal-body">
          <h3>➕ Новий користувач / Nowy użytkownik</h3>
          <form onSubmit={createUser} className="new-user-form">
            <input placeholder="Email" type="email" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} required />
            <input placeholder="Пароль / Hasło" type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} required minLength={6} />
            <input placeholder="Ім'я / Imię" value={newUser.full_name} onChange={e => setNewUser({...newUser, full_name: e.target.value})} required />
            <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})}>
              {Object.entries(ROLES).map(([key, val]) => (
                <option key={key} value={key}>{val.uk} / {val.pl}</option>
              ))}
            </select>
            <button type="submit" disabled={creating}>{creating ? '...' : 'Створити / Utwórz'}</button>
          </form>

          <h3>📋 Список користувачів / Lista użytkowników ({users.length})</h3>
          <div className="users-list">
            {users.map(user => (
              <div key={user.id} className={'user-item ' + (user.is_active ? '' : 'inactive')}>
                <div className="user-info">
                  <strong>{user.full_name || user.email}</strong>
                  <small>{user.email}</small>
                </div>
                <select value={user.role} onChange={e => updateUserRole(user.id, e.target.value)} disabled={user.id === currentUser.id}>
                  {Object.entries(ROLES).map(([key, val]) => (
                    <option key={key} value={key}>{val.uk}</option>
                  ))}
                </select>
                {user.id !== currentUser.id && (
                  <button className={user.is_active ? 'btn-danger' : 'btn-success'} onClick={() => toggleUserActive(user.id, user.is_active)}>
                    {user.is_active ? '🔒' : '🔓'}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// Main App Component
export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState([])
  const [selectedCompany, setSelectedCompany] = useState(null)
  const [sections, setSections] = useState([])
  const [activeSection, setActiveSection] = useState(null)
  const [documents, setDocuments] = useState([])
  const [statuses, setStatuses] = useState({})
  const [showUserManagement, setShowUserManagement] = useState(false)

  // Initialize auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session) loadProfile(data.session.user.id)
      else setLoading(false)
    })
    supabase.auth.onAuthStateChange((_, session) => {
      setSession(session)
      if (session) loadProfile(session.user.id)
    })
  }, [])

  // Load user profile
  const loadProfile = async (userId) => {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
    setProfile(data)
    loadCompanies()
  }

  // Load companies
  const loadCompanies = async () => {
    const { data } = await supabase.from('companies').select('*').order('order_index')
    setCompanies(data || [])
    if (data && data.length > 0) {
      setSelectedCompany(data[0])
    }
    setLoading(false)
  }

  // Load sections when company changes
  useEffect(() => {
    if (selectedCompany) loadSections()
  }, [selectedCompany])

  const loadSections = async () => {
    const { data } = await supabase
      .from('document_sections')
      .select('*')
      .eq('company_id', selectedCompany.id)
      .is('parent_section_id', null)
      .order('order_index')
    setSections(data || [])
    if (data && data.length > 0) {
      setActiveSection(data[0])
    }
  }

  // Load documents when section changes
  useEffect(() => {
    if (activeSection) loadDocuments()
  }, [activeSection])

  const loadDocuments = async () => {
    // Get section and sub-sections
    const { data: subSections } = await supabase
      .from('document_sections')
      .select('id')
      .eq('parent_section_id', activeSection.id)
    
    const sectionIds = [activeSection.id, ...(subSections || []).map(s => s.id)]
    
    const { data } = await supabase
      .from('documents')
      .select('*, responsible:responsible_user_id(full_name, email)')
      .in('section_id', sectionIds)
      .order('order_index')
    setDocuments(data || [])
  }

  const updateStatus = async (docId, status) => {
    setStatuses(prev => ({ ...prev, [docId]: status }))
    await supabase.from('documents').update({ status, updated_at: new Date().toISOString() }).eq('id', docId)
    
    // Log to audit
    await supabase.rpc('log_audit', {
      p_user_id: profile.id,
      p_action: 'update_status',
      p_entity_type: 'document',
      p_entity_id: docId,
      p_details: { status }
    })
  }

  if (loading) return <div className="loading">Завантаження... / Ładowanie...</div>
  if (!session) return <Auth />
  if (!profile) return <div className="loading">Завантаження профілю... / Ładowanie profilu...</div>

  const isAdmin = profile.role === 'super_admin' || profile.role === 'lawyer_admin'
  const totalDocs = documents.length
  const completedDocs = documents.filter(d => d.status === 'done').length
  const progress = totalDocs > 0 ? Math.round((completedDocs / totalDocs) * 100) : 0

  return (
    <div className="app">
      <header>
        <h1>📋 Audit System</h1>
        <div className="header-controls">
          <span className="user-info">
            {profile.full_name} ({ROLES[profile.role]?.uk})
          </span>
          {profile.role === 'super_admin' && (
            <button className="btn-icon" onClick={() => setShowUserManagement(true)} title="Користувачі">👥</button>
          )}
          <select value={selectedCompany?.id || ''} onChange={e => {
            const company = companies.find(c => c.id === e.target.value)
            setSelectedCompany(company)
          }}>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name_uk} / {c.name_pl}</option>
            ))}
          </select>
          <button onClick={() => supabase.auth.signOut()}>Вийти / Wyloguj</button>
        </div>
      </header>

      <div className="progress-bar">
        <div className="progress" style={{ width: progress + '%' }}></div>
        <span>{completedDocs} / {totalDocs} документів / dokumentów ({progress}%)</span>
      </div>

      <nav className="sections">
        {sections.map(s => (
          <button
            key={s.id}
            className={activeSection?.id === s.id ? 'active' : ''}
            onClick={() => setActiveSection(s)}
          >
            {s.code}
          </button>
        ))}
      </nav>

      <main>
        <h2>{activeSection?.name_uk} / {activeSection?.name_pl}</h2>
        <div className="documents">
          {documents.map(doc => {
            const status = statuses[doc.id] || doc.status || 'pending'
            return (
              <div key={doc.id} className={'doc-item ' + status}>
                <div className="doc-main">
                  <span className="doc-code">{doc.code}</span>
                  <div className="doc-names">
                    <span className="doc-name-uk">{doc.name_uk}</span>
                    <span className="doc-name-pl">{doc.name_pl}</span>
                  </div>
                </div>
                <div className="doc-meta">
                  {doc.responsible && (
                    <span className="doc-responsible" title="Відповідальний / Odpowiedzialny">
                      👤 {doc.responsible.full_name || doc.responsible.email}
                    </span>
                  )}
                </div>
                <select value={status} onChange={e => updateStatus(doc.id, e.target.value)} disabled={!isAdmin}>
                  {STATUS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.uk} / {opt.pl}</option>
                  ))}
                </select>
              </div>
            )
          })}
          {documents.length === 0 && (
            <div className="no-docs">Немає документів / Brak dokumentów</div>
          )}
        </div>
      </main>

      {showUserManagement && (
        <UserManagement currentUser={profile} onClose={() => setShowUserManagement(false)} />
      )}
    </div>
  )
}
