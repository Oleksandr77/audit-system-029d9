import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'

const companies = [
  { id: 'liceum', name: 'Liceum (UA)', country: 'UA' },
  { id: 'prestiz', name: 'Prestiż (UA)', country: 'UA' },
  { id: 'nowa-szkola', name: 'Nowa Szkoła (PL)', country: 'PL' },
  { id: 'integra', name: 'Integra (PL)', country: 'PL' }
]

const sections = [
  { id: 'A', name: 'A. Документи реєстрації', docs: ['A1. Статут', 'A2. Виписка з реєстру', 'A3. Свідоцтво ПДВ', 'A4. Довідка банк', 'A5. Картка'] },
  { id: 'B', name: 'B. Фінансова звітність', docs: ['B1. Баланс 2023', 'B2. Звіт фін результати', 'B3. Рух коштів', 'B4. Примітки', 'B5. Аудит'] },
  { id: 'C', name: 'C. Податкова звітність', docs: ['C1. ПДВ декларація', 'C2. Податок на прибуток', 'C3. ЄСВ', 'C4. 1ДФ', 'C5. Акти ДПС'] },
  { id: 'D', name: 'D. Банківські документи', docs: ['D1. Виписки', 'D2. Договори банк', 'D3. Кредити', 'D4. Гарантії', 'D5. Платіжки'] },
  { id: 'E', name: 'E. Договори', docs: ['E1. Постачальники', 'E2. Покупці', 'E3. Оренда', 'E4. Трудові', 'E5. Послуги'] },
  { id: 'F', name: 'F. Кадрові документи', docs: ['F1. Штатний розпис', 'F2. Накази', 'F3. Табелі', 'F4. ЗП відомості', 'F5. Особові справи'] },
  { id: 'G', name: 'G. Первинні документи', docs: ['G1. Накладні', 'G2. Акти робіт', 'G3. Рахунки', 'G4. Каса', 'G5. Авансові'] },
  { id: 'H', name: 'H. Основні засоби', docs: ['H1. Інвентарні', 'H2. Введення ОЗ', 'H3. Амортизація', 'H4. Списання', 'H5. Інвентаризація'] },
  { id: 'I', name: 'I. Внутрішні документи', docs: ['I1. Протоколи', 'I2. Накази', 'I3. Облік політика', 'I4. Інструкції', 'I5. Положення'] },
  { id: 'J', name: 'J. Інші документи', docs: ['J1. Ліцензії', 'J2. Сертифікати', 'J3. Страхування', 'J4. Судові', 'J5. Листування'] }
]

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
    } catch (err) { setError(err.message) }
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
  const [company, setCompany] = useState('liceum')
  const [activeSection, setActiveSection] = useState('A')
  const [statuses, setStatuses] = useState({})

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    supabase.auth.onAuthStateChange((_, session) => setSession(session))
  }, [])

  useEffect(() => {
    if (session) loadStatuses()
  }, [session, company])

  const loadStatuses = async () => {
    const { data } = await supabase.from('document_statuses').select('*').eq('company_id', company)
    if (data) {
      const map = {}
      data.forEach(d => map[d.doc_id] = d.status)
      setStatuses(map)
    }
  }

  const updateStatus = async (docId, status) => {
    setStatuses(prev => ({ ...prev, [docId]: status }))
    await supabase.from('document_statuses').upsert({
      company_id: company, doc_id: docId, status: status, updated_at: new Date().toISOString()
    }, { onConflict: 'company_id,doc_id' })
  }

  if (loading) return <div className="loading">Завантаження...</div>
  if (!session) return <Auth />

  const currentSection = sections.find(s => s.id === activeSection)
  const totalDocs = sections.reduce((sum, s) => sum + s.docs.length, 0)
  const completedDocs = Object.values(statuses).filter(s => s === 'done').length
  const progress = Math.round((completedDocs/totalDocs)*100)

  return (
    <div className="app">
      <header>
        <h1>Audit System</h1>
        <div className="header-controls">
          <select value={company} onChange={e => setCompany(e.target.value)}>
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={() => supabase.auth.signOut()}>Вийти</button>
        </div>
      </header>
      
      <div className="progress-bar">
        <div className="progress" style={{width: progress + '%'}}></div>
        <span>{completedDocs} / {totalDocs} документів ({progress}%)</span>
      </div>

      <nav className="sections">
        {sections.map(s => (
          <button key={s.id} className={activeSection === s.id ? 'active' : ''} onClick={() => setActiveSection(s.id)}>{s.id}</button>
        ))}
      </nav>

      <main>
        <h2>{currentSection?.name}</h2>
        <div className="documents">
          {currentSection?.docs.map((doc, i) => {
            const docId = activeSection + (i+1)
            const status = statuses[docId] || 'pending'
            return (
              <div key={docId} className={'doc-item ' + status}>
                <span className="doc-name">{doc}</span>
                <select value={status} onChange={e => updateStatus(docId, e.target.value)}>
                  <option value="pending">⏳ Очікує</option>
                  <option value="in-progress">🔄 В роботі</option>
                  <option value="done">✅ Готово</option>
                  <option value="missing">❌ Відсутній</option>
                </select>
              </div>
            )
          })}
        </div>
      </main>
    </div>
  )
}
