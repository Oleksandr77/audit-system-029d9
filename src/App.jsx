import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext, Component } from 'react'
import { supabase } from './lib/supabase'

// =====================================================
// CONSTANTS
// =====================================================
const ROLES = {
  super_admin: { pl: 'Super Admin', uk: 'Супер Адмін' },
  lawyer_admin: { pl: 'Prawnik Admin', uk: 'Юрист Адмін' },
  lawyer_auditor: { pl: 'Prawnik Audytor', uk: 'Юрист Аудитор' },
  user_fnu: { pl: 'Użytkownik FNU', uk: 'Користувач FNU' },
  user_operator: { pl: 'Użytkownik OPERATOR', uk: 'Користувач OPERATOR' }
}

const SIDES = {
  FNU: { pl: 'FNU (Strona dostarczająca)', uk: 'FNU (Сторона що надає)' },
  OPERATOR: { pl: 'OPERATOR (Strona audytu)', uk: 'OPERATOR (Сторона аудиту)' }
}

const STATUS_OPTIONS = [
  { value: 'pending', pl: '⏳ Oczekuje', uk: 'Очікує' },
  { value: 'in_progress', pl: '🔄 W trakcie', uk: 'В роботі' },
  { value: 'done', pl: '✅ Gotowe', uk: 'Готово' },
  { value: 'missing', pl: '❌ Brak', uk: 'Відсутній' }
]

const MAX_FILE_SIZE = 100 * 1024 * 1024
const MAX_FILES_PER_DOC = 100
const MAX_COMMENT_LENGTH = 500
const MAX_MESSAGE_LENGTH = 500
const MAX_LLM_SUGGESTIONS = 3
const RATE_LIMIT_MS = 1000
const USERS_PAGE_SIZE = 20

const LANGUAGE_MODES = ['auto', 'pl', 'uk']
const SIDE_DEFAULT_LANGUAGE = { FNU: 'uk', OPERATOR: 'pl' }
const TRANSLATION_TIMEOUT_MS = 6000
const LLM_MAX_RETRIES = 3
const TRANSLATE_CACHE_TTL_MS = 30 * 60 * 1000
const SUGGEST_CACHE_TTL_MS = 10 * 60 * 1000

const ALLOWED_FILE_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv'
]

const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv']

const FILE_ICONS = {
  'pdf': '📕', 'doc': '📘', 'docx': '📘', 'xls': '📗',
  'xlsx': '📗', 'txt': '📄', 'csv': '📊', 'default': '📎'
}

const translateCache = new Map()
const suggestCache = new Map()

// =====================================================
// ERROR BOUNDARY (Critical for Production)
// =====================================================
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught:', error, errorInfo)
    // In production: send to Sentry/LogRocket
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary" role="alert">
          <div className="error-content">
            <h2>
              <span className="text-pl">Coś poszło nie tak</span>
              <span className="text-uk">Щось пішло не так</span>
            </h2>
            <p>
              <span className="text-pl">Wystąpił błąd. Spróbuj odświeżyć.</span>
              <span className="text-uk">Виникла помилка. Спробуйте оновити.</span>
            </p>
            <div className="error-actions">
              <button onClick={this.handleReset} className="btn-secondary">
                Spróbuj ponownie / Спробувати
              </button>
              <button onClick={() => window.location.reload()} className="btn-primary">
                Odśwież / Оновити
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// =====================================================
// BILINGUAL TEXT (with a11y)
// =====================================================
function BiText({ pl, uk, className = '' }) {
  return (
    <span className={`bi-text ${className}`}>
      <span className="text-pl">{pl}</span>
      <span className="text-uk" aria-hidden="true">{uk}</span>
    </span>
  )
}

// =====================================================
// SECURITY UTILITIES (Enhanced XSS Protection)
// =====================================================

// Enhanced sanitization - prevents XSS including javascript: URIs
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/javascript:/gi, '') // Block javascript: URIs
    .replace(/data:/gi, 'data_blocked:') // Block data: URIs
    .replace(/vbscript:/gi, '') // Block vbscript:
    .replace(/on\w+\s*=/gi, '') // Block event handlers
    .trim()
}

// Safe text display component (prevents XSS in rendered content)
function SafeText({ children }) {
  if (typeof children !== 'string') return children
  return <>{sanitizeText(children)}</>
}

function sanitizeFileName(originalName) {
  const uuid = crypto.randomUUID()
  const lastDot = originalName.lastIndexOf('.')
  let extension = lastDot > 0
    ? originalName.substring(lastDot).toLowerCase().replace(/[^a-z0-9.]/g, '')
    : ''
  if (!ALLOWED_EXTENSIONS.includes(extension)) extension = '.bin'
  return `${uuid}${extension}`
}

function getFileExtension(filename) {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : 'default'
}

function isValidUUID(str) {
  if (!str || typeof str !== 'string') return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)
}

function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: 'Plik przekracza 100MB / Файл перевищує 100MB' }
  }
  const ext = '.' + getFileExtension(file.name)
  if (!ALLOWED_EXTENSIONS.includes(ext) && !ALLOWED_FILE_TYPES.includes(file.type)) {
    return { valid: false, error: 'Niedozwolony typ pliku / Недозволений тип файлу' }
  }
  return { valid: true }
}

function detectLanguage(text) {
  if (!text || typeof text !== 'string') return 'uk'
  const sample = text.toLowerCase()
  const ukMatch = sample.match(/[іїєґ]/g)?.length || 0
  const plMatch = sample.match(/[ąćęłńóśźż]/g)?.length || 0
  if (ukMatch > plMatch) return 'uk'
  if (plMatch > ukMatch) return 'pl'
  return 'uk'
}

function resolveLanguageMode(mode, profileSide) {
  if (mode === 'pl' || mode === 'uk') return mode
  return SIDE_DEFAULT_LANGUAGE[profileSide] || 'uk'
}

async function callWithTimeout(promise, timeoutMs) {
  return await Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
  ])
}

function makeTranslateCacheKey(text, source, target) {
  return `${source}|${target}|${text}`
}

function makeSuggestCacheKey(prefix, language, context) {
  const contextHint = (context || '').slice(0, 600)
  return `${language}|${prefix}|${contextHint}`
}

function getCachedValue(cache, key, ttlMs) {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > ttlMs) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function setCachedValue(cache, key, value) {
  cache.set(key, { value, ts: Date.now() })
}

function sanitizeLlmContext(text) {
  if (!text || typeof text !== 'string') return ''
  return sanitizeText(text)
    .replace(/ignore\s+previous\s+instructions/gi, '')
    .replace(/system\s*prompt/gi, '')
    .replace(/developer\s*message/gi, '')
    .replace(/reveal\s+all\s+data/gi, '')
    .slice(0, 2800)
}

async function callLlmWithRetry(requestFactory, fallbackValue) {
  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    try {
      const result = await requestFactory()
      return result
    } catch (error) {
      if (attempt === LLM_MAX_RETRIES - 1) return fallbackValue
      const backoffMs = 250 * Math.pow(2, attempt)
      await new Promise(resolve => setTimeout(resolve, backoffMs))
    }
  }
  return fallbackValue
}

async function llmTranslateStrict(text, source, target) {
  // Expected Edge Function contract: { translated_text: string }
  if (!text || source === target) return text || ''
  const cacheKey = makeTranslateCacheKey(text, source, target)
  const cached = getCachedValue(translateCache, cacheKey, TRANSLATE_CACHE_TTL_MS)
  if (cached) return cached

  return await callLlmWithRetry(async () => {
    const { data, error } = await callWithTimeout(
      supabase.functions.invoke('llm-translator', {
        body: {
          mode: 'translate',
          source_language: source,
          target_language: target,
          text,
          strict: true,
          system_instruction: 'Translate only. No explanations. Preserve names, dates, numbers and punctuation. Output only translated text.'
        }
      }),
      TRANSLATION_TIMEOUT_MS
    )
    if (error) throw error
    const translated = sanitizeText(data?.translated_text || '')
    const finalValue = translated || text
    setCachedValue(translateCache, cacheKey, finalValue)
    return finalValue
  }, text)
}

async function llmSuggestCompletions(prefix, language, context = '') {
  // Expected Edge Function contract: { suggestions: string[] }
  if (!prefix || prefix.trim().length < 3) return []
  const cleanContext = sanitizeLlmContext(context)
  const cacheKey = makeSuggestCacheKey(prefix.trim(), language, cleanContext)
  const cached = getCachedValue(suggestCache, cacheKey, SUGGEST_CACHE_TTL_MS)
  if (cached) return cached

  return await callLlmWithRetry(async () => {
    const { data, error } = await callWithTimeout(
      supabase.functions.invoke('llm-translator', {
        body: {
          mode: 'suggest',
          language,
          text: prefix.trim(),
          context: cleanContext,
          max_items: MAX_LLM_SUGGESTIONS,
          strict: true,
          system_instruction: 'Return 1-3 short continuation options in the same language, based on provided context. No extra commentary.'
        }
      }),
      TRANSLATION_TIMEOUT_MS
    )
    if (error) throw error
    const suggestions = Array.isArray(data?.suggestions) ? data.suggestions : []
    const finalSuggestions = suggestions.map(s => sanitizeText(String(s))).filter(Boolean).slice(0, MAX_LLM_SUGGESTIONS)
    setCachedValue(suggestCache, cacheKey, finalSuggestions)
    return finalSuggestions
  }, [])
}

function resolveDisplayedText(item, displayLanguage) {
  const source = item?.source_language || detectLanguage(item?.content || '')
  const content = item?.content || ''
  const parsedContent = parseMessageContextEnvelope(content).text
  if (displayLanguage === 'pl') {
    if (source === 'pl') return parsedContent
    return parseMessageContextEnvelope(item?.translated_pl || content).text
  }
  if (source === 'uk') return parsedContent
  return parseMessageContextEnvelope(item?.translated_uk || content).text
}

function buildMessageContextEnvelope({ companyId, sectionId, documentId, topic }) {
  return `[[CTX|c:${companyId || ''}|s:${sectionId || ''}|d:${documentId || ''}|t:${sanitizeText(topic || '')}]]`
}

function parseMessageContextEnvelope(value) {
  const raw = String(value || '')
  const match = raw.match(/^\[\[CTX\|c:(.*?)\|s:(.*?)\|d:(.*?)\|t:(.*?)\]\]\n?([\s\S]*)$/)
  if (!match) {
    return { text: raw, context: null }
  }
  return {
    context: {
      companyId: match[1] || '',
      sectionId: match[2] || '',
      documentId: match[3] || '',
      topic: match[4] || ''
    },
    text: match[5] || ''
  }
}

function getNextSectionCode(sections) {
  const topLevelCodes = (sections || [])
    .map(s => String(s.code || '').trim().toUpperCase())
    .filter(code => /^[A-Z]$/.test(code))
  if (topLevelCodes.length === 0) return 'A'
  const maxChar = topLevelCodes
    .map(code => code.charCodeAt(0))
    .sort((a, b) => b - a)[0]
  if (maxChar < 90) return String.fromCharCode(maxChar + 1)
  return `A${topLevelCodes.length + 1}`
}

// =====================================================
// CUSTOM HOOKS
// =====================================================
function useDebounce(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])
  return debouncedValue
}

function useFocusTrap(ref, isActive) {
  useEffect(() => {
    if (!isActive || !ref.current) return
    const modal = ref.current
    const focusable = modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    const first = focusable[0], last = focusable[focusable.length - 1]
    const handleKey = (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
      }
    }
    first?.focus()
    modal.addEventListener('keydown', handleKey)
    return () => modal.removeEventListener('keydown', handleKey)
  }, [ref, isActive])
}

function useSafeAsync() {
  const isMounted = useRef(true)
  useEffect(() => {
    isMounted.current = true
    return () => { isMounted.current = false }
  }, [])
  return useCallback((callback) => {
    return (...args) => {
      if (isMounted.current) callback(...args)
    }
  }, [])
}

// =====================================================
// CONTEXTS
// =====================================================
const ToastContext = createContext(null)
const ProfileContext = createContext(null)

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }, [])

  return (
    <ToastContext.Provider value={addToast}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {toasts.map(t => <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>)}
      </div>
    </ToastContext.Provider>
  )
}

function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be within ToastProvider')
  return ctx
}

function useProfile() {
  return useContext(ProfileContext)
}

// =====================================================
// AUDIT LOGGING
// =====================================================
async function logAudit(userId, action, entityType, entityId, details = null) {
  if (!isValidUUID(userId)) return
  try {
    await supabase.from('audit_log').insert({
      user_id: userId,
      action: sanitizeText(action),
      entity_type: sanitizeText(entityType),
      entity_id: entityId,
      details
    })
  } catch (e) { console.error('Audit error:', e) }
}

// =====================================================
// AUTH COMPONENT
// =====================================================
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
    } catch (err) { setError(err.message) }
    setLoading(false)
  }

  return (
    <div className="auth-container">
      <div className="auth-shell">
        <aside className="auth-hero" aria-label="FNU education visual">
          <div className="auth-brand">
            <div className="auth-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 100 100" role="img">
                <polygon points="50,7 82,25 82,62 50,81 18,62 18,25" fill="none" stroke="currentColor" strokeWidth="8" />
                <circle cx="50" cy="44" r="12" fill="none" stroke="currentColor" strokeWidth="6" />
              </svg>
            </div>
            <div>
              <p className="auth-brand-top">Foundation</p>
              <h2>Unbreakable Ukraine</h2>
            </div>
          </div>

          <p className="auth-hero-title">
            <span className="text-pl">Audyt edukacji i dokumentów szkół</span><br />
            <span className="text-uk">Аудит освіти та документації шкіл</span>
          </p>

          <div className="auth-hero-grid">
            <div className="auth-scene-card scene-school">
              <div className="scene-icon" aria-hidden="true">🏫</div>
              <strong>Szkoły / Школи</strong>
              <span>Dokumenty, statuty, raporty</span>
            </div>
            <div className="auth-scene-card scene-students">
              <div className="scene-icon" aria-hidden="true">🧑‍🎓</div>
              <strong>Uczniowie / Учні</strong>
              <span>Proces, jakość, bezpieczeństwo</span>
            </div>
            <div className="auth-scene-card scene-online">
              <div className="scene-icon" aria-hidden="true">💻</div>
              <strong>Zdalna nauka / Дистанційка</strong>
              <span>Platformy i komunikacja</span>
            </div>
            <div className="auth-scene-card scene-subjects">
              <div className="scene-icon" aria-hidden="true">📚</div>
              <strong>Przedmioty / Предмети</strong>
              <span>Matematyka, języki, nauki</span>
            </div>
          </div>

          <div className="auth-flag-strip" aria-label="PL-UA collaboration">
            <span className="flag-pill flag-pl">PL</span>
            <span className="flag-link">↔</span>
            <span className="flag-pill flag-ua">UA</span>
            <span className="flag-note">Wspólny standard edukacyjny / Спільний освітній стандарт</span>
          </div>
        </aside>

        <section className="auth-box">
          <p className="auth-kicker">Audit System</p>
          <h1>Logowanie / Вхід</h1>
          <p className="auth-subtitle">
            <span className="text-pl">System zarządzania dokumentami audytu</span><br />
            <span className="text-uk">Система управління документами аудиту</span>
          </p>
          <form onSubmit={handleSubmit}>
            <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
            <input type="password" placeholder="Hasło / Пароль" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
            {error && <div className="error" role="alert">{error}</div>}
            <button type="submit" disabled={loading}>{loading ? '...' : 'Zaloguj / Увійти'}</button>
          </form>
        </section>
      </div>
    </div>
  )
}

// =====================================================
// FILE UPLOAD COMPONENT
// =====================================================
function FileUpload({ document, onUpdate, canAdd, canDelete, canView }) {
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [versionTableReady, setVersionTableReady] = useState(true)
  const [expandedVersionFileId, setExpandedVersionFileId] = useState(null)
  const [versionsByFile, setVersionsByFile] = useState({})
  const [loadingVersionsByFile, setLoadingVersionsByFile] = useState({})
  const [rollingBackVersionId, setRollingBackVersionId] = useState(null)
  const [previewFile, setPreviewFile] = useState(null)
  const [previewMode, setPreviewMode] = useState('frame')
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewText, setPreviewText] = useState('')
  const [previewLoading, setPreviewLoading] = useState(false)
  const [editingText, setEditingText] = useState(false)
  const [savingText, setSavingText] = useState(false)
  const fileInputRef = useRef(null)
  const abortControllerRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()
  const safeSetState = useSafeAsync()

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      if (previewUrl && previewUrl.startsWith('blob:')) {
        URL.revokeObjectURL(previewUrl)
      }
    }
  }, [previewUrl])

  const loadFiles = useCallback(async () => {
    if (!document?.id || !isValidUUID(document.id)) return

    const baseQuery = supabase.from('document_files').select('*').eq('document_id', document.id)
    let query = baseQuery.order('created_at')

    if (profile?.side === 'OPERATOR') {
      const { data: accessData } = await supabase
        .from('document_access')
        .select('file_id')
        .eq('document_id', document.id)
        .eq('visible_to_operator', true)

      if (accessData && accessData.length > 0) {
        const fileIds = accessData.map(a => a.file_id).filter(Boolean)
        if (fileIds.length > 0) {
          query = query.in('id', fileIds)
        } else {
          safeSetState(setFiles)([])
          return
        }
      } else {
        safeSetState(setFiles)([])
        return
      }
    }

    let { data, error } = await query
    if (error && /created_at/i.test(error.message || '')) {
      const fallbackResult = await baseQuery.order('uploaded_at')
      data = fallbackResult.data
      error = fallbackResult.error
    }
    if (error && /uploaded_at/i.test(error.message || '')) {
      const fallbackNoOrder = await baseQuery
      data = fallbackNoOrder.data
      error = fallbackNoOrder.error
    }
    if (error) {
      addToast(`Błąd listy plików: ${sanitizeText(error.message || 'query_failed')}`, 'error')
      safeSetState(setFiles)([])
      return
    }
    safeSetState(setFiles)(data || [])
  }, [document?.id, profile?.side, safeSetState, addToast])

  useEffect(() => { loadFiles() }, [loadFiles])

  const loadVersionsForFile = useCallback(async (fileId) => {
    if (!fileId || !versionTableReady) return
    safeSetState(setLoadingVersionsByFile)(prev => ({ ...prev, [fileId]: true }))
    const { data, error } = await supabase
      .from('document_file_versions')
      .select('*')
      .eq('file_id', fileId)
      .order('version_no', { ascending: false })

    if (error) {
      if (/document_file_versions|relation .* does not exist|column .* does not exist/i.test(error.message || '')) {
        setVersionTableReady(false)
        addToast('Wersje plików nieaktywne: uruchom SQL migrację / Версії файлів неактивні: запустіть SQL міграцію', 'warning')
      } else {
        addToast(`Błąd wersji: ${sanitizeText(error.message || 'version_query_failed')}`, 'error')
      }
      safeSetState(setVersionsByFile)(prev => ({ ...prev, [fileId]: [] }))
    } else {
      safeSetState(setVersionsByFile)(prev => ({ ...prev, [fileId]: data || [] }))
    }
    safeSetState(setLoadingVersionsByFile)(prev => ({ ...prev, [fileId]: false }))
  }, [safeSetState, addToast, versionTableReady])

  const makeVersionPath = (file) => {
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const safeName = sanitizeFileName(file.file_name || `file-${file.id}`)
    return `versions/${document.id}/${file.id}/${ts}-${safeName}`
  }

  const snapshotCurrentVersion = useCallback(async (file, reason = 'manual') => {
    if (!versionTableReady) return
    const { data: currentBlob, error: downloadError } = await supabase.storage.from('documents').download(file.file_path)
    if (downloadError) throw downloadError
    const versionPath = makeVersionPath(file)

    const { error: uploadVersionError } = await supabase.storage
      .from('documents')
      .upload(versionPath, currentBlob, { upsert: false })
    if (uploadVersionError) throw uploadVersionError

    const { data: lastVersionData, error: lastVersionError } = await supabase
      .from('document_file_versions')
      .select('version_no')
      .eq('file_id', file.id)
      .order('version_no', { ascending: false })
      .limit(1)

    if (lastVersionError && !/document_file_versions|relation .* does not exist/i.test(lastVersionError.message || '')) {
      throw lastVersionError
    }
    const nextVersion = ((lastVersionData && lastVersionData[0]?.version_no) || 0) + 1

    const { error: insertVersionError } = await supabase.from('document_file_versions').insert({
      file_id: file.id,
      document_id: document.id,
      version_no: nextVersion,
      storage_path: versionPath,
      file_name: file.file_name,
      file_size: file.file_size || 0,
      mime_type: file.mime_type || null,
      file_type: file.file_type || null,
      change_reason: reason,
      created_by: profile.id
    })

    if (insertVersionError) {
      if (/document_file_versions|relation .* does not exist|column .* does not exist/i.test(insertVersionError.message || '')) {
        setVersionTableReady(false)
        addToast('Wersje plików nieaktywne: uruchom SQL migrację / Версії файлів неактивні: запустіть SQL міграцію', 'warning')
        return
      }
      throw insertVersionError
    }
    await logAudit(profile.id, 'create_file_version', 'document_file', file.id, { reason, version_no: nextVersion })
  }, [versionTableReady, document.id, profile.id, addToast])

  const handleUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files || [])
    if (selectedFiles.length === 0) return
    if (!profile?.id) {
      addToast('Brak profilu użytkownika / Немає профілю користувача', 'error')
      return
    }
    if (files.length + selectedFiles.length > MAX_FILES_PER_DOC) {
      addToast(`Maksymalnie ${MAX_FILES_PER_DOC} plików / Максимум ${MAX_FILES_PER_DOC} файлів`, 'error')
      return
    }

    abortControllerRef.current = new AbortController()
    setUploading(true)
    setUploadProgress(0)

    const CONCURRENT_UPLOADS = 3
    let completed = 0
    const total = selectedFiles.length
    let successCount = 0
    let failedCount = 0

    for (let i = 0; i < selectedFiles.length; i += CONCURRENT_UPLOADS) {
      if (abortControllerRef.current?.signal.aborted) break

      const batch = selectedFiles.slice(i, i + CONCURRENT_UPLOADS)

      await Promise.all(batch.map(async (file) => {
        if (abortControllerRef.current?.signal.aborted) return

        const validation = validateFile(file)
        if (!validation.valid) {
          addToast(validation.error, 'error')
          failedCount++
          completed++
          return
        }

        const safeFileName = sanitizeFileName(file.name)
        const filePath = `${document.id}/${safeFileName}`

        try {
          const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, file)
          if (uploadError) throw uploadError

          const ext = getFileExtension(file.name)
          const { data: fileData, error: dbError } = await supabase.from('document_files').insert({
            document_id: document.id,
            file_name: sanitizeText(file.name),
            file_path: filePath,
            file_size: file.size,
            file_type: ext,
            mime_type: file.type,
            uploaded_by: profile.id
          }).select().single()

          if (dbError) {
            await supabase.storage.from('documents').remove([filePath])
            throw dbError
          }

          await logAudit(profile.id, 'upload_file', 'document_file', document.id, { file_name: file.name })

          if (profile.side === 'FNU' && fileData) {
            await supabase.from('document_access').insert({
              document_id: document.id,
              file_id: fileData.id,
              visible_to_operator: false
            })
          }
          successCount++
        } catch (err) {
          failedCount++
          const reason = sanitizeText(err?.message || 'upload_failed')
          addToast(`Błąd: ${file.name} (${reason})`, 'error')
          console.error('Upload error:', err)
        }

        completed++
        safeSetState(setUploadProgress)(Math.round((completed / total) * 100))
      }))
    }

    if (!abortControllerRef.current?.signal.aborted) {
      if (successCount > 0 && failedCount === 0) {
        addToast(`Pliki przesłane (${successCount}) / Файли завантажено (${successCount})`, 'success')
      } else if (successCount > 0 && failedCount > 0) {
        addToast(`Częściowo: ${successCount} OK, ${failedCount} błędów / Частково: ${successCount} OK, ${failedCount} помилок`, 'warning')
      } else if (failedCount > 0) {
        addToast('Wysyłka nieudana / Завантаження не вдалося', 'error')
      }
    }
    setUploading(false)
    setUploadProgress(0)
    loadFiles()
    onUpdate?.()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDelete = async (fileId, filePath) => {
    if (!confirm('Usunąć plik? / Видалити файл?')) return
    const fileRecord = files.find(f => f.id === fileId)
    if (fileRecord && versionTableReady) {
      try {
        await snapshotCurrentVersion(fileRecord, 'before_delete')
      } catch (err) {
        addToast(`Błąd wersji przed usunięciem: ${sanitizeText(err?.message || 'snapshot_failed')}`, 'warning')
      }
    }
    await supabase.storage.from('documents').remove([filePath])
    await supabase.from('document_files').delete().eq('id', fileId)
    await logAudit(profile.id, 'delete_file', 'document_file', fileId)
    loadFiles()
    onUpdate?.()
    addToast('Plik usunięty / Файл видалено', 'success')
    if (previewFile?.id === fileId) {
      setPreviewFile(null)
      setPreviewText('')
      if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
      setPreviewUrl('')
    }
  }

  const handleDownload = async (filePath, fileName) => {
    const { data } = await supabase.storage.from('documents').download(filePath)
    if (data) {
      const url = URL.createObjectURL(data)
      const a = window.document.createElement('a')
      a.href = url; a.download = fileName; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
      await logAudit(profile.id, 'download_file', 'document_file', document.id)
    }
  }

  const handlePreview = async (filePath) => {
    const { data } = await supabase.storage.from('documents').createSignedUrl(filePath, 3600)
    if (data?.signedUrl) {
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
      await logAudit(profile.id, 'view_file', 'document_file', document.id)
    }
  }

  const publishToOperator = async (fileId) => {
    try {
      await supabase.from('document_access').upsert({
        document_id: document.id,
        file_id: fileId,
        visible_to_operator: true,
        published_at: new Date().toISOString(),
        published_by: profile.id
      }, { onConflict: 'document_id,file_id' })

      const { data: operators } = await supabase
        .from('profiles')
        .select('id')
        .eq('side', 'OPERATOR')
        .eq('is_active', true)

      if (operators && operators.length > 0) {
        const notifications = operators.map(op => ({
          user_id: op.id,
          type: 'new_document',
          title: 'Nowe dokumenty / Нові документи',
          message: 'Dodano nowe dokumenty do przeglądu / Додано нові документи',
          entity_type: 'document',
          entity_id: document.id
        }))
        await supabase.from('notifications').insert(notifications)
      }

      addToast('Opublikowano dla OPERATOR / Опубліковано для OPERATOR', 'success')
      loadFiles()
    } catch (err) {
      addToast('Błąd publikacji / Помилка публікації', 'error')
      console.error('Publish error:', err)
    }
  }

  const openInlinePreview = async (file) => {
    setPreviewFile(file)
    setPreviewMode('frame')
    setEditingText(false)
    setPreviewText('')
    if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
    setPreviewUrl('')
    setPreviewLoading(true)

    const ext = (file.file_type || getFileExtension(file.file_name)).toLowerCase()
    const isTextLike = ['txt', 'csv'].includes(ext) || (file.mime_type || '').startsWith('text/')

    try {
      if (isTextLike) {
        const { data, error } = await supabase.storage.from('documents').download(file.file_path)
        if (error) throw error
        const text = await data.text()
        setPreviewText(text)
        setPreviewMode('text')
      } else {
        const { data, error } = await supabase.storage.from('documents').download(file.file_path)
        if (error) throw error
        const blobUrl = URL.createObjectURL(data)
        setPreviewUrl(blobUrl)
        const ext = (file.file_type || getFileExtension(file.file_name)).toLowerCase()
        const previewable = ext === 'pdf' || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)
        setPreviewMode(previewable ? 'frame' : 'unsupported')
      }
      await logAudit(profile.id, 'view_file', 'document_file', document.id)
    } catch (err) {
      addToast(`Błąd podglądu: ${sanitizeText(err?.message || 'preview_failed')}`, 'error')
      setPreviewFile(null)
    } finally {
      setPreviewLoading(false)
    }
  }

  const saveInlineText = async () => {
    if (!previewFile) return
    setSavingText(true)
    try {
      if (versionTableReady) {
        try {
          await snapshotCurrentVersion(previewFile, 'before_inline_edit')
        } catch (err) {
          addToast(`Błąd wersji: ${sanitizeText(err?.message || 'version_failed')}`, 'warning')
        }
      }
      const blob = new Blob([previewText], { type: previewFile.mime_type || 'text/plain' })
      const updateResult = await supabase.storage.from('documents').update(previewFile.file_path, blob)
      if (updateResult.error) {
        const fallbackUpload = await supabase.storage.from('documents').upload(previewFile.file_path, blob, { upsert: true })
        if (fallbackUpload.error) throw fallbackUpload.error
      }

      await supabase
        .from('document_files')
        .update({ file_size: blob.size })
        .eq('id', previewFile.id)

      await logAudit(profile.id, 'edit_file', 'document_file', previewFile.id, { mode: 'inline-text' })
      addToast('Zapisano zmiany / Зміни збережено', 'success')
      setEditingText(false)
      loadFiles()
      onUpdate?.()
    } catch (err) {
      addToast(`Błąd zapisu: ${sanitizeText(err?.message || 'save_failed')}`, 'error')
    } finally {
      setSavingText(false)
    }
  }

  const rollbackVersion = async (file, version) => {
    if (!file || !version) return
    setRollingBackVersionId(version.id)
    try {
      if (versionTableReady) {
        try {
          await snapshotCurrentVersion(file, `before_rollback_to_v${version.version_no}`)
        } catch (err) {
          addToast(`Błąd snapshotu rollback: ${sanitizeText(err?.message || 'rollback_snapshot_failed')}`, 'warning')
        }
      }

      const { data: versionBlob, error: versionDownloadError } = await supabase.storage
        .from('documents')
        .download(version.storage_path)
      if (versionDownloadError) throw versionDownloadError

      const { error: restoreError } = await supabase.storage
        .from('documents')
        .upload(file.file_path, versionBlob, { upsert: true })
      if (restoreError) throw restoreError

      await supabase
        .from('document_files')
        .update({
          file_size: version.file_size || file.file_size,
          mime_type: version.mime_type || file.mime_type,
          file_type: version.file_type || file.file_type
        })
        .eq('id', file.id)

      await logAudit(profile.id, 'rollback_file_version', 'document_file', file.id, { version_no: version.version_no })
      addToast(`Rollback do v${version.version_no} / Відкат до v${version.version_no}`, 'success')
      await loadFiles()
      await loadVersionsForFile(file.id)
      onUpdate?.()
      if (previewFile?.id === file.id) {
        setPreviewFile({ ...previewFile, file_size: version.file_size || previewFile.file_size })
      }
    } catch (err) {
      addToast(`Błąd rollback: ${sanitizeText(err?.message || 'rollback_failed')}`, 'error')
    } finally {
      setRollingBackVersionId(null)
    }
  }

  if (!canView) return null

  return (
    <div className="file-upload">
      <div className="files-header">
        <BiText pl={`Pliki (${files.length}/${MAX_FILES_PER_DOC})`} uk={`Файли (${files.length}/${MAX_FILES_PER_DOC})`} />
        {canAdd && files.length < MAX_FILES_PER_DOC && (
          <label className="upload-btn">
            {uploading ? `${uploadProgress}%` : '+ Dodaj / Додати'}
            <input ref={fileInputRef} type="file" accept={ALLOWED_EXTENSIONS.join(',')} multiple onChange={handleUpload} disabled={uploading} style={{ display: 'none' }} />
          </label>
        )}
      </div>
      {uploading && (
        <div className="upload-progress" role="progressbar" aria-valuenow={uploadProgress} aria-valuemin="0" aria-valuemax="100" aria-label="Upload progress">
          <div className="upload-progress-bar" style={{ width: `${uploadProgress}%` }} />
        </div>
      )}
      <ul className="files-list">
        {files.map(file => {
          const ext = file.file_type || getFileExtension(file.file_name)
          const icon = FILE_ICONS[ext] || FILE_ICONS.default
          return (
            <li key={file.id} className="file-item">
              <span className="file-icon" aria-hidden="true">{icon}</span>
              <span className="file-name" title={file.file_name}>{file.file_name}</span>
              <span className="file-size">{(file.file_size / 1024 / 1024).toFixed(2)} MB</span>
              <div className="file-actions">
                <button onClick={() => openInlinePreview(file)} aria-label="Podgląd wewnętrzny / Вбудований перегляд">🧾</button>
                <button onClick={() => handlePreview(file.file_path)} aria-label="Podgląd zewnętrzny / Зовнішній перегляд">👁️</button>
                <button
                  onClick={async () => {
                    const open = expandedVersionFileId === file.id
                    setExpandedVersionFileId(open ? null : file.id)
                    if (!open) await loadVersionsForFile(file.id)
                  }}
                  aria-label="Wersje / Версії"
                >
                  🕘
                </button>
                <button onClick={() => handleDownload(file.file_path, file.file_name)} aria-label="Pobierz / Завантажити">⬇️</button>
                {canDelete && <button onClick={() => handleDelete(file.id, file.file_path)} aria-label="Usuń / Видалити">🗑️</button>}
                {profile?.side === 'FNU' && profile?.role === 'super_admin' && (
                  <button onClick={() => publishToOperator(file.id)} aria-label="Opublikuj dla OPERATOR" className="btn-publish">📤</button>
                )}
              </div>
              {expandedVersionFileId === file.id && (
                <div className="file-versions">
                  {loadingVersionsByFile[file.id] ? (
                    <span className="file-versions-empty">Ładowanie wersji... / Завантаження версій...</span>
                  ) : (
                    <>
                      {(versionsByFile[file.id] || []).length === 0 ? (
                        <span className="file-versions-empty">Brak wersji / Немає версій</span>
                      ) : (
                        (versionsByFile[file.id] || []).map(v => (
                          <div key={v.id} className="file-version-item">
                            <span>v{v.version_no}</span>
                            <span>{new Date(v.created_at).toLocaleString()}</span>
                            <button
                              type="button"
                              onClick={() => rollbackVersion(file, v)}
                              disabled={rollingBackVersionId === v.id}
                            >
                              {rollingBackVersionId === v.id ? '...' : 'Rollback'}
                            </button>
                          </div>
                        ))
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          )
        })}
        {files.length === 0 && <li className="no-files"><BiText pl="Brak plików" uk="Немає файлів" /></li>}
      </ul>

      {previewFile && (
        <div className="inline-preview">
          <div className="inline-preview-header">
            <strong><SafeText>{previewFile.file_name}</SafeText></strong>
            <div className="inline-preview-actions">
              {(previewFile.file_type === 'txt' || previewFile.file_type === 'csv' || (previewFile.mime_type || '').startsWith('text/')) && (
                <>
                  {!editingText ? (
                    <button type="button" onClick={() => setEditingText(true)}>✏️ Edytuj / Редагувати</button>
                  ) : (
                    <button type="button" onClick={saveInlineText} disabled={savingText}>{savingText ? '...' : '💾 Zapisz / Зберегти'}</button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={() => {
                  setPreviewFile(null)
                  setPreviewText('')
                  if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
                  setPreviewUrl('')
                }}
              >
                ✕
              </button>
            </div>
          </div>

          {previewLoading ? (
            <div className="inline-preview-loading">Ładowanie... / Завантаження...</div>
          ) : (
            <>
              {previewMode === 'text' ? (
                editingText ? (
                  <textarea
                    className="inline-text-editor"
                    value={previewText}
                    onChange={e => setPreviewText(e.target.value)}
                    aria-label="Edytor pliku tekstowego"
                  />
                ) : (
                  <pre className="inline-text-preview">{previewText}</pre>
                )
              ) : previewMode === 'unsupported' ? (
                <div className="inline-preview-loading">
                  Podgląd tego formatu wbudowanie nie jest wspierany / Вбудований перегляд цього формату не підтримується
                </div>
              ) : (
                <iframe className="inline-file-frame" src={previewUrl} title={previewFile.file_name} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// =====================================================
// COMMENT ITEM COMPONENT (Memoized for performance)
// =====================================================
const CommentItem = ({ comment, depth, maxDepth, onReply, onToggleVisibility, canComment, canToggle, displayLanguage }) => {
  if (depth >= maxDepth) return null
  const renderedContent = resolveDisplayedText(comment, displayLanguage)

  return (
    <div className={`comment ${depth > 0 ? 'reply' : ''}`} style={{ marginLeft: depth * 16 }}>
      <div className="comment-header">
        <span className="comment-author">
          <SafeText>{comment.author?.full_name || comment.author?.email}</SafeText>
          <span className={`side-badge ${comment.author?.side?.toLowerCase()}`}>{comment.author?.side}</span>
        </span>
        <time dateTime={comment.created_at}>{new Date(comment.created_at).toLocaleString()}</time>
      </div>
      <p className="comment-content"><SafeText>{renderedContent}</SafeText></p>
      <div className="comment-actions">
        {canComment && depth < maxDepth - 1 && (
          <button onClick={() => onReply(comment.id)} aria-label="Odpowiedz / Відповісти">↩️ Odpowiedz</button>
        )}
        {canToggle && (
          <button onClick={() => onToggleVisibility(comment.id, comment.visible_to_sides || [])}>
            {(comment.visible_to_sides || []).includes('OPERATOR') ? '🔓 OPERATOR' : '🔒 FNU'}
          </button>
        )}
      </div>
    </div>
  )
}

// =====================================================
// COMMENTS COMPONENT
// =====================================================
function Comments({ document, canComment, canView, displayLanguage }) {
  const [comments, setComments] = useState([])
  const [newComment, setNewComment] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const addToast = useToast()
  const profile = useProfile()
  const safeSetState = useSafeAsync()
  const MAX_REPLY_DEPTH = 5
  const resolvedDisplayLanguage = displayLanguage === 'pl' ? 'pl' : 'uk'

  const loadComments = useCallback(async () => {
    if (!document?.id) return
    const { data } = await supabase
      .from('comments')
      .select('*, author:author_id(full_name, email, side)')
      .eq('document_id', document.id)
      .order('created_at')

    const filtered = (data || []).filter(c => {
      if (profile?.role === 'super_admin') return true
      if (!c.visible_to_sides) return true
      return c.visible_to_sides.includes(profile?.side)
    })
    safeSetState(setComments)(filtered)
  }, [document?.id, profile, safeSetState])

  useEffect(() => { if (canView) loadComments() }, [canView, loadComments])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!newComment.trim() || newComment.length > MAX_COMMENT_LENGTH) return
    setSubmitting(true)
    const cleanContent = sanitizeText(newComment.trim())
    const sourceLanguage = detectLanguage(cleanContent)
    const [translatedPl, translatedUk] = await Promise.all([
      sourceLanguage === 'pl' ? Promise.resolve(cleanContent) : llmTranslateStrict(cleanContent, sourceLanguage, 'pl'),
      sourceLanguage === 'uk' ? Promise.resolve(cleanContent) : llmTranslateStrict(cleanContent, sourceLanguage, 'uk')
    ])

    const { data, error } = await supabase.from('comments').insert({
      document_id: document.id,
      author_id: profile.id,
      content: cleanContent,
      source_language: sourceLanguage,
      translated_pl: translatedPl,
      translated_uk: translatedUk,
      translation_provider: 'smart-api',
      parent_comment_id: replyTo,
      visible_to_sides: profile.side === 'FNU' ? ['FNU'] : ['FNU', 'OPERATOR']
    }).select().single()

    if (!error && data) {
      await logAudit(profile.id, 'add_comment', 'comment', data.id)
      setNewComment('')
      setReplyTo(null)
      loadComments()
      addToast('Komentarz dodany / Коментар додано', 'success')
    }
    setSubmitting(false)
  }

  const toggleVisibility = async (commentId, currentSides) => {
    const newSides = currentSides.includes('OPERATOR') ? ['FNU'] : ['FNU', 'OPERATOR']
    await supabase.from('comments').update({ visible_to_sides: newSides }).eq('id', commentId)
    loadComments()
    addToast('Widoczność zmieniona / Видимість змінено', 'success')
  }

  if (!canView) return null

  const topLevel = comments.filter(c => !c.parent_comment_id)
  const getReplies = (parentId) => comments.filter(c => c.parent_comment_id === parentId)

  const renderCommentTree = (comment, depth = 0) => (
    <div key={comment.id}>
      <CommentItem
        comment={comment}
        depth={depth}
        maxDepth={MAX_REPLY_DEPTH}
        onReply={setReplyTo}
        onToggleVisibility={toggleVisibility}
        canComment={canComment}
        canToggle={profile?.role === 'super_admin'}
        displayLanguage={resolvedDisplayLanguage}
      />
      {getReplies(comment.id).map(r => renderCommentTree(r, depth + 1))}
    </div>
  )

  return (
    <section className="comments-section" aria-label="Komentarze / Коментарі">
      <h4><BiText pl={`Komentarze (${comments.length})`} uk={`Коментарі (${comments.length})`} /></h4>

      {canComment && (
        <form onSubmit={handleSubmit} className="comment-form">
          {replyTo && (
            <div className="replying-to">
              <BiText pl="Odpowiedź na komentarz" uk="Відповідь на коментар" />
              <button type="button" onClick={() => setReplyTo(null)} aria-label="Anuluj odpowiedź">✕</button>
            </div>
          )}
          <textarea
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            placeholder="Napisz komentarz... / Напишіть коментар..."
            maxLength={MAX_COMMENT_LENGTH}
            aria-label="Treść komentarza"
          />
          <div className="comment-footer">
            <span aria-live="polite">{newComment.length}/{MAX_COMMENT_LENGTH}</span>
            <button type="submit" disabled={submitting || !newComment.trim()}>
              {submitting ? '...' : 'Wyślij / Надіслати'}
            </button>
          </div>
        </form>
      )}

      <div className="comments-list" role="feed" aria-label="Lista komentarzy">
        {topLevel.map(c => renderCommentTree(c))}
        {comments.length === 0 && <div className="no-comments"><BiText pl="Brak komentarzy" uk="Немає коментарів" /></div>}
      </div>
    </section>
  )
}

// =====================================================
// CHAT COMPONENT (SECURE + AUTO TRANSLATION)
// =====================================================
function Chat({
  displayLanguageMode,
  onDisplayLanguageModeChange,
  contextHint,
  contextSeed,
  initialMessageDraft,
  onDraftConsumed,
  companies = [],
  selectedCompanyId,
  activeSectionId
}) {
  const [messages, setMessages] = useState([])
  const [attachmentsByMessage, setAttachmentsByMessage] = useState({})
  const [threads, setThreads] = useState([])
  const [threadMembers, setThreadMembers] = useState({})
  const [users, setUsers] = useState([])
  const [selectedThreadId, setSelectedThreadId] = useState(null)
  const [selectedDirectUserId, setSelectedDirectUserId] = useState(null)
  const [selectedRecipients, setSelectedRecipients] = useState([])
  const [recipientMode, setRecipientMode] = useState('direct')
  const [newMessage, setNewMessage] = useState('')
  const [discussionTopic, setDiscussionTopic] = useState('')
  const [pendingFiles, setPendingFiles] = useState([])
  const [llmSuggestions, setLlmSuggestions] = useState([])
  const [loadingSuggestions, setLoadingSuggestions] = useState(false)
  const [sending, setSending] = useState(false)
  const [userSearch, setUserSearch] = useState('')
  const [targetCompanyId, setTargetCompanyId] = useState(selectedCompanyId || '')
  const [targetSectionId, setTargetSectionId] = useState(activeSectionId || '')
  const [targetDocumentId, setTargetDocumentId] = useState('')
  const [targetSections, setTargetSections] = useState([])
  const [targetDocuments, setTargetDocuments] = useState([])
  const fileInputRef = useRef(null)
  const debouncedSearch = useDebounce(userSearch, 300)
  const debouncedMessage = useDebounce(newMessage, 350)
  const lastMessageTime = useRef(0)
  const messagesEndRef = useRef(null)
  const channelRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()
  const safeSetState = useSafeAsync()
  const currentThread = useMemo(
    () => threads.find(t => t.id === selectedThreadId) || null,
    [threads, selectedThreadId]
  )
  const displayLanguage = useMemo(
    () => resolveLanguageMode(displayLanguageMode, profile?.side),
    [displayLanguageMode, profile?.side]
  )

  useEffect(() => {
    if (selectedCompanyId) setTargetCompanyId(selectedCompanyId)
  }, [selectedCompanyId])

  useEffect(() => {
    if (activeSectionId) setTargetSectionId(activeSectionId)
  }, [activeSectionId])

  useEffect(() => {
    if (!contextSeed) return
    if (contextSeed.companyId) setTargetCompanyId(contextSeed.companyId)
    if (contextSeed.sectionId) setTargetSectionId(contextSeed.sectionId)
    if (contextSeed.documentId) setTargetDocumentId(contextSeed.documentId)
    if (contextSeed.topic) setDiscussionTopic(contextSeed.topic)
    setSelectedThreadId(null)
  }, [contextSeed])

  useEffect(() => {
    if (!initialMessageDraft) return
    setNewMessage(initialMessageDraft)
    onDraftConsumed?.()
  }, [initialMessageDraft, onDraftConsumed])

  useEffect(() => {
    const loadUsers = async () => {
      if (!profile?.id) return
      let query = supabase
        .from('profiles')
        .select('id, full_name, email, side, role')
        .eq('is_active', true)
        .neq('id', profile.id)
        .limit(USERS_PAGE_SIZE)

      if (debouncedSearch) {
        query = query.or(`full_name.ilike.%${sanitizeText(debouncedSearch)}%,email.ilike.%${sanitizeText(debouncedSearch)}%`)
      }

      if (profile.role !== 'super_admin') {
        const { data: permissions } = await supabase
          .from('chat_permissions')
          .select('can_message_user_id')
          .eq('user_id', profile.id)
        if (permissions && permissions.length > 0) {
          const allowedIds = permissions.map(p => p.can_message_user_id).filter(isValidUUID)
          if (allowedIds.length > 0) query = query.in('id', allowedIds)
          else return safeSetState(setUsers)([])
        } else {
          return safeSetState(setUsers)([])
        }
      }

      const { data } = await query
      safeSetState(setUsers)(data || [])
    }
    loadUsers()
  }, [profile?.id, profile?.role, debouncedSearch, safeSetState])

  useEffect(() => {
    if (recipientMode === 'direct' && selectedDirectUserId) {
      setSelectedRecipients([selectedDirectUserId])
    }
  }, [recipientMode, selectedDirectUserId])

  useEffect(() => {
    const loadSections = async () => {
      if (!targetCompanyId || !isValidUUID(targetCompanyId)) {
        safeSetState(setTargetSections)([])
        return
      }
      const { data } = await supabase
        .from('document_sections')
        .select('id, code, name_pl, name_uk')
        .eq('company_id', targetCompanyId)
        .is('parent_section_id', null)
        .order('order_index')
      safeSetState(setTargetSections)(data || [])
      if ((!targetSectionId || !data?.some(s => s.id === targetSectionId)) && data?.length > 0) {
        setTargetSectionId(data[0].id)
      }
    }
    loadSections()
  }, [targetCompanyId, targetSectionId, safeSetState])

  useEffect(() => {
    const loadDocumentsForTarget = async () => {
      if (!targetSectionId || !isValidUUID(targetSectionId)) {
        safeSetState(setTargetDocuments)([])
        return
      }
      const { data: subSections } = await supabase
        .from('document_sections')
        .select('id')
        .eq('parent_section_id', targetSectionId)
      const sectionIds = [targetSectionId, ...(subSections || []).map(s => s.id)]
      const { data } = await supabase
        .from('documents')
        .select('id, code, name_pl, name_uk')
        .in('section_id', sectionIds)
        .order('order_index')
      safeSetState(setTargetDocuments)(data || [])
      if ((!targetDocumentId || !data?.some(d => d.id === targetDocumentId)) && data?.length > 0) {
        setTargetDocumentId(data[0].id)
      }
    }
    loadDocumentsForTarget()
  }, [targetSectionId, targetDocumentId, safeSetState])

  const loadThreads = useCallback(async () => {
    if (!profile?.id) return
    const { data, error } = await supabase
      .from('chat_thread_members')
      .select(`
        thread_id,
        thread:thread_id (
          id,
          company_id,
          section_id,
          document_id,
          topic,
          updated_at,
          created_by,
          is_archived
        )
      `)
      .eq('user_id', profile.id)
      .eq('is_active', true)
      .order('joined_at', { ascending: false })

    if (error) {
      safeSetState(setThreads)([])
      return
    }

    const normalized = (data || [])
      .map(row => row.thread)
      .filter(Boolean)
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))

    safeSetState(setThreads)(normalized)
    if (!selectedThreadId && normalized.length > 0) setSelectedThreadId(normalized[0].id)
  }, [profile?.id, safeSetState, selectedThreadId])

  const loadThreadMembers = useCallback(async (threadList) => {
    const ids = (threadList || []).map(t => t.id).filter(isValidUUID)
    if (ids.length === 0) return safeSetState(setThreadMembers)({})
    const { data, error } = await supabase
      .from('chat_thread_members')
      .select('thread_id, user_id, member_role, user:user_id(id, full_name, email, side)')
      .in('thread_id', ids)
      .eq('is_active', true)
    if (error) return safeSetState(setThreadMembers)({})
    const grouped = (data || []).reduce((acc, item) => {
      if (!acc[item.thread_id]) acc[item.thread_id] = []
      acc[item.thread_id].push(item)
      return acc
    }, {})
    safeSetState(setThreadMembers)(grouped)
  }, [safeSetState])

  useEffect(() => {
    loadThreads()
  }, [loadThreads])

  useEffect(() => {
    loadThreadMembers(threads)
  }, [threads, loadThreadMembers])

  const loadAttachments = useCallback(async (messageList) => {
    const ids = (messageList || []).map(m => m.id).filter(isValidUUID)
    if (ids.length === 0) return safeSetState(setAttachmentsByMessage)({})
    const { data, error } = await supabase
      .from('chat_attachments')
      .select('*')
      .in('message_id', ids)
      .order('created_at', { ascending: true })
    if (error) return safeSetState(setAttachmentsByMessage)({})
    const grouped = (data || []).reduce((acc, item) => {
      if (!acc[item.message_id]) acc[item.message_id] = []
      acc[item.message_id].push(item)
      return acc
    }, {})
    safeSetState(setAttachmentsByMessage)(grouped)
  }, [safeSetState])

  const loadMessages = useCallback(async () => {
    if (!selectedThreadId || !isValidUUID(selectedThreadId)) {
      safeSetState(setMessages)([])
      safeSetState(setAttachmentsByMessage)({})
      return
    }
    const { data } = await supabase
      .from('chat_messages')
      .select('*, sender:sender_id(full_name, email, side)')
      .eq('thread_id', selectedThreadId)
      .order('created_at', { ascending: true })
      .limit(120)
    const allMessages = data || []
    safeSetState(setMessages)(allMessages)
    loadAttachments(allMessages)
  }, [selectedThreadId, safeSetState, loadAttachments])

  useEffect(() => {
    if (!profile?.id || !isValidUUID(profile.id)) return
    channelRef.current = supabase
      .channel(`chat_${profile.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
        if (payload.new.thread_id && payload.new.thread_id === selectedThreadId) loadMessages()
      })
      .subscribe()
    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current)
    }
  }, [profile?.id, selectedThreadId, loadMessages])

  useEffect(() => {
    if (selectedThreadId) loadMessages()
  }, [selectedThreadId, loadMessages])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const loadSuggestions = async () => {
      if (!debouncedMessage.trim()) return safeSetState(setLlmSuggestions)([])
      const recentMessagesContext = messages
        .slice(-6)
        .map((m) => `${m.sender?.full_name || m.sender?.email || 'User'}: ${resolveDisplayedText(m, displayLanguage)}`)
        .join('\n')
      const fullContext = [contextHint || '', discussionTopic, recentMessagesContext].filter(Boolean).join('\n')
      safeSetState(setLoadingSuggestions)(true)
      const suggestions = await llmSuggestCompletions(debouncedMessage, detectLanguage(debouncedMessage), fullContext)
      safeSetState(setLlmSuggestions)(suggestions)
      safeSetState(setLoadingSuggestions)(false)
    }
    loadSuggestions()
  }, [debouncedMessage, safeSetState, messages, displayLanguage, contextHint, discussionTopic])

  const onPickFiles = (e) => {
    const picked = Array.from(e.target.files || [])
    const valid = []
    for (const file of picked) {
      const result = validateFile(file)
      if (!result.valid) {
        addToast(result.error, 'error')
        continue
      }
      valid.push(file)
    }
    setPendingFiles(prev => [...prev, ...valid].slice(0, 10))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removePendingFile = (name) => {
    setPendingFiles(prev => prev.filter(f => f.name !== name))
  }

  const findDirectThreadWithUser = useCallback((userId) => {
    if (!userId || !profile?.id) return null
    return threads.find((thread) => {
      const members = threadMembers[thread.id] || []
      if (members.length !== 2) return false
      const ids = members.map(m => m.user_id)
      return ids.includes(profile.id) && ids.includes(userId)
    }) || null
  }, [threads, threadMembers, profile?.id])

  const selectDirectUser = (userId) => {
    setRecipientMode('direct')
    setSelectedDirectUserId(userId)
    setSelectedRecipients([userId])
    const existing = findDirectThreadWithUser(userId)
    if (existing) {
      setSelectedThreadId(existing.id)
      setDiscussionTopic(existing.topic || '')
      if (existing.company_id) setTargetCompanyId(existing.company_id)
      if (existing.section_id) setTargetSectionId(existing.section_id)
      if (existing.document_id) setTargetDocumentId(existing.document_id)
    } else {
      setSelectedThreadId(null)
    }
  }

  const toggleRecipient = (id) => {
    setSelectedRecipients(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const uploadAttachmentsForMessage = async (messageId, threadId, recipientId = null) => {
    if (pendingFiles.length === 0) return
    for (const file of pendingFiles) {
      const ext = getFileExtension(file.name)
      const safeFileName = sanitizeFileName(file.name)
      const filePath = `chat/${targetCompanyId}/${targetSectionId}/${targetDocumentId}/${messageId}/${safeFileName}`
      const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, file)
      if (uploadError) throw uploadError
      const { error: dbError } = await supabase.from('chat_attachments').insert({
        message_id: messageId,
        thread_id: threadId,
        sender_id: profile.id,
        recipient_id: recipientId,
        company_id: targetCompanyId,
        section_id: targetSectionId,
        document_id: targetDocumentId,
        file_name: sanitizeText(file.name),
        file_path: filePath,
        file_size: file.size,
        file_type: ext,
        mime_type: file.type
      })
      if (dbError) {
        await supabase.storage.from('documents').remove([filePath])
        throw dbError
      }
    }
    await supabase.from('chat_messages').update({ has_attachments: true }).eq('id', messageId)
  }

  const openAttachment = async (attachment) => {
    const { data } = await supabase.storage.from('documents').createSignedUrl(attachment.file_path, 3600)
    if (data?.signedUrl) window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  const downloadAttachment = async (attachment) => {
    const { data } = await supabase.storage.from('documents').download(attachment.file_path)
    if (data) {
      const url = URL.createObjectURL(data)
      const a = window.document.createElement('a')
      a.href = url
      a.download = attachment.file_name
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    }
  }

  const createThread = async (recipients) => {
    const cleanRecipients = Array.from(new Set(recipients.filter(isValidUUID)))
    const { data: thread, error: threadError } = await supabase
      .from('chat_threads')
      .insert({
        company_id: targetCompanyId,
        section_id: targetSectionId,
        document_id: targetDocumentId,
        topic: sanitizeText(discussionTopic.trim()),
        created_by: profile.id
      })
      .select()
      .single()
    if (threadError || !thread?.id) throw threadError || new Error('Thread not created')

    const members = [profile.id, ...cleanRecipients].map((userId) => ({
      thread_id: thread.id,
      user_id: userId,
      member_role: userId === profile.id ? 'owner' : 'member',
      is_active: true
    }))
    const { error: membersError } = await supabase.from('chat_thread_members').insert(members)
    if (membersError) throw membersError
    await loadThreads()
    return thread
  }

  const sendMessage = async (e) => {
    e.preventDefault()
    const recipients = (recipientMode === 'group' ? selectedRecipients : [selectedDirectUserId]).filter(isValidUUID)
    if ((!newMessage.trim() && pendingFiles.length === 0) || (recipients.length === 0 && !selectedThreadId)) return
    if (!targetCompanyId || !targetSectionId || !targetDocumentId) {
      addToast('Wybierz firmę, sekcję i dokument / Виберіть компанію, секцію і документ', 'warning')
      return
    }
    if (!discussionTopic.trim()) {
      addToast('Wpisz temat dyskusji / Вкажіть тему обговорення', 'warning')
      return
    }

    const now = Date.now()
    if (now - lastMessageTime.current < RATE_LIMIT_MS) {
      addToast('Zbyt szybko / Занадто швидко', 'warning')
      return
    }
    lastMessageTime.current = now

    const messagePlain = sanitizeText(newMessage.trim() || (pendingFiles.length > 0 ? '📎 Attachment' : ''))
    if (messagePlain.length > MAX_MESSAGE_LENGTH) {
      addToast(`Maksymalnie ${MAX_MESSAGE_LENGTH} znaków`, 'error')
      return
    }

    setSending(true)
    const sourceLanguage = detectLanguage(messagePlain)
    const translatedPl = sourceLanguage === 'pl' ? messagePlain : await llmTranslateStrict(messagePlain, sourceLanguage, 'pl')
    const translatedUk = sourceLanguage === 'uk' ? messagePlain : await llmTranslateStrict(messagePlain, sourceLanguage, 'uk')

    const envelope = buildMessageContextEnvelope({
      companyId: targetCompanyId,
      sectionId: targetSectionId,
      documentId: targetDocumentId,
      topic: discussionTopic
    })

    try {
      let threadId = selectedThreadId
      if (!threadId) {
        const createdThread = await createThread(recipients)
        threadId = createdThread.id
        setSelectedThreadId(threadId)
      }

      const { data: createdMessage, error } = await supabase.from('chat_messages').insert({
        sender_id: profile.id,
        thread_id: threadId,
        recipient_id: null,
        content: `${envelope}\n${messagePlain}`,
        source_language: sourceLanguage,
        translated_pl: `${envelope}\n${translatedPl}`,
        translated_uk: `${envelope}\n${translatedUk}`,
        translation_provider: 'llm-translator',
        has_attachments: pendingFiles.length > 0
      }).select().single()
      if (error || !createdMessage?.id) throw error || new Error('Message not created')
      if (pendingFiles.length > 0) {
        await uploadAttachmentsForMessage(createdMessage.id, threadId, recipientMode === 'direct' ? recipients[0] : null)
      }

      await loadThreads()
      if (threadId) setSelectedThreadId(threadId)
      setNewMessage('')
      setLlmSuggestions([])
      setPendingFiles([])
    } catch (err) {
      addToast('Błąd wysyłania / Помилка надсилання', 'error')
      console.error('Send message error:', err)
    }
    setSending(false)
  }

  return (
    <div className="chat-panel" role="region" aria-label="Czat / Чат">
      <div className="chat-header">
        <div className="chat-title-stack">
          <BiText pl="Czat roboczy" uk="Робочий чат" />
          {contextHint && <small className="chat-context"><SafeText>{contextHint}</SafeText></small>}
        </div>
        <div className="chat-language-controls">
          <label htmlFor="chat-recipient-mode"><BiText pl="Adresaci" uk="Одержувачі" /></label>
          <select id="chat-recipient-mode" value={recipientMode} onChange={e => setRecipientMode(e.target.value)}>
            <option value="direct">Direct</option>
            <option value="group">Group</option>
          </select>
          <label htmlFor="chat-language-mode">Język / Мова</label>
          <select
            id="chat-language-mode"
            value={displayLanguageMode}
            onChange={e => {
              const nextMode = e.target.value
              if (LANGUAGE_MODES.includes(nextMode)) onDisplayLanguageModeChange(nextMode)
            }}
          >
            <option value="auto">Auto</option>
            <option value="pl">Polski</option>
            <option value="uk">Українська</option>
          </select>
          <span className="language-pill">{displayLanguage.toUpperCase()}</span>
        </div>
      </div>

      <div className="chat-body">
        <div className="chat-users">
          <div className="threads-list">
            {threads.map(thread => (
              <button
                key={thread.id}
                className={`thread-item ${selectedThreadId === thread.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedThreadId(thread.id)
                  setDiscussionTopic(thread.topic || '')
                  if (thread.company_id) setTargetCompanyId(thread.company_id)
                  if (thread.section_id) setTargetSectionId(thread.section_id)
                  if (thread.document_id) setTargetDocumentId(thread.document_id)
                }}
              >
                <strong><SafeText>{thread.topic || 'Thread'}</SafeText></strong>
                <small>{(threadMembers[thread.id] || []).length} users</small>
              </button>
            ))}
          </div>
          <input
            type="search"
            placeholder="Szukaj... / Пошук..."
            value={userSearch}
            onChange={e => setUserSearch(e.target.value)}
            className="user-search"
            aria-label="Szukaj użytkownika"
          />
          <div className="users-list" role="listbox" aria-label="Lista kontaktów">
            {users.map(u => (
              <div key={u.id} className={`chat-user ${selectedDirectUserId === u.id ? 'active' : ''}`}>
                <button type="button" className="chat-user-main" onClick={() => selectDirectUser(u.id)} role="option" aria-selected={selectedDirectUserId === u.id}>
                  <span className="user-name"><SafeText>{u.full_name || u.email}</SafeText></span>
                  <span className={`side-badge ${u.side?.toLowerCase()}`}>{u.side}</span>
                </button>
                <label className="chat-user-select">
                  <input
                    type="checkbox"
                    checked={selectedRecipients.includes(u.id)}
                    onChange={() => toggleRecipient(u.id)}
                  />
                  <span>{recipientMode === 'group' ? 'Do grupy' : 'Adresat'}</span>
                </label>
              </div>
            ))}
            {users.length === 0 && (
              <div className="no-contacts">
                <BiText pl="Brak kontaktów" uk="Немає контактів" />
              </div>
            )}
          </div>
        </div>

        <div className="chat-messages">
          {selectedThreadId || selectedRecipients.length > 0 ? (
            <>
              <div className="messages-list" role="log" aria-live="polite" aria-atomic="false" aria-label="Historia wiadomości">
                {messages.map(m => {
                  const parsed = parseMessageContextEnvelope(resolveDisplayedText(m, displayLanguage))
                  const rawCtx = parseMessageContextEnvelope(m.content).context
                  return (
                    <div key={m.id} className={`message ${m.sender_id === profile?.id ? 'sent' : 'received'}`}>
                      <div className="message-header">
                        <span className="message-sender"><SafeText>{m.sender?.full_name || m.sender?.email}</SafeText></span>
                        <span className={`side-badge ${m.sender?.side?.toLowerCase()}`}>{m.sender?.side}</span>
                      </div>
                      {rawCtx?.topic && <span className="message-context-chip"><SafeText>{rawCtx.topic}</SafeText></span>}
                      <p className="message-content"><SafeText>{parsed.text}</SafeText></p>
                      {(attachmentsByMessage[m.id] || []).length > 0 && (
                        <div className="message-attachments">
                          {(attachmentsByMessage[m.id] || []).map(att => (
                            <div key={att.id} className="message-attachment-card">
                              <span className="attachment-name"><SafeText>{att.file_name}</SafeText></span>
                              <span className="attachment-meta">{(att.file_size / 1024 / 1024).toFixed(2)} MB</span>
                              <div className="attachment-actions">
                                <button type="button" onClick={() => openAttachment(att)}>👁️</button>
                                <button type="button" onClick={() => downloadAttachment(att)}>⬇️</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <time className="message-time" dateTime={m.created_at}>{new Date(m.created_at).toLocaleString()}</time>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>

              <div className="attachment-target">
                <select value={targetCompanyId} onChange={e => setTargetCompanyId(e.target.value)} aria-label="Firma">
                  <option value="">Firma / Компанія</option>
                  {companies.map(c => <option key={c.id} value={c.id}>{c.name_pl || c.name}</option>)}
                </select>
                <select value={targetSectionId} onChange={e => setTargetSectionId(e.target.value)} aria-label="Sekcja">
                  <option value="">Sekcja / Секція</option>
                  {targetSections.map(s => <option key={s.id} value={s.id}>{s.code} {s.name_pl}</option>)}
                </select>
                <select value={targetDocumentId} onChange={e => setTargetDocumentId(e.target.value)} aria-label="Dokument">
                  <option value="">Dokument / Документ</option>
                  {targetDocuments.map(d => <option key={d.id} value={d.id}>{d.code} {d.name_pl}</option>)}
                </select>
                <input
                  type="text"
                  value={discussionTopic}
                  onChange={e => setDiscussionTopic(e.target.value)}
                  placeholder="Temat dyskusji / Тема обговорення"
                  maxLength={120}
                  aria-label="Temat dyskusji"
                />
                <label className="chat-attach-btn">
                  📎
                  <input ref={fileInputRef} type="file" multiple onChange={onPickFiles} style={{ display: 'none' }} />
                </label>
              </div>

              {pendingFiles.length > 0 && (
                <div className="pending-files">
                  {pendingFiles.map(file => (
                    <button key={file.name + file.size} type="button" onClick={() => removePendingFile(file.name)}>
                      <SafeText>{file.name}</SafeText> ✕
                    </button>
                  ))}
                </div>
              )}

              <form onSubmit={sendMessage} className="message-form">
                <textarea
                  value={newMessage}
                  onChange={e => setNewMessage(e.target.value)}
                  placeholder="Napisz wiadomość... / Напишіть повідомлення..."
                  maxLength={MAX_MESSAGE_LENGTH}
                  aria-label="Treść wiadomości"
                  rows={3}
                />
                <button type="submit" disabled={sending || (!newMessage.trim() && pendingFiles.length === 0)} aria-label="Wyślij wiadomość">📤</button>
              </form>

              <div className="llm-suggestions" aria-live="polite">
                {loadingSuggestions ? (
                  <span className="llm-hint">...</span>
                ) : (
                  llmSuggestions.map((hint, idx) => (
                    <button key={idx} type="button" onClick={() => setNewMessage(hint)}>{hint}</button>
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="select-user"><BiText pl="Wybierz kontakt lub temat" uk="Виберіть контакт або тему" /></div>
          )}
        </div>
      </div>
    </div>
  )
}

// =====================================================
// USER MANAGEMENT COMPONENT
// =====================================================
function UserManagement({ onClose }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [newUser, setNewUser] = useState({ email: '', password: '', full_name: '', phone: '', position: '', company_name: '', role: 'user_fnu', side: 'FNU' })
  const [creating, setCreating] = useState(false)
  const modalRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()
  const safeSetState = useSafeAsync()

  useFocusTrap(modalRef, true)

  useEffect(() => {
    const loadUsers = async () => {
      const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
      safeSetState(setUsers)(data || [])
      safeSetState(setLoading)(false)
    }
    loadUsers()
  }, [safeSetState])

  const createUser = async (e) => {
    e.preventDefault()
    setCreating(true)
    try {
      const { data, error } = await supabase.auth.signUp({
        email: newUser.email,
        password: newUser.password,
        options: { data: { full_name: newUser.full_name, role: newUser.role, side: newUser.side } }
      })
      if (error) throw error

      if (data.user) {
        await supabase.from('profiles').upsert({
          id: data.user.id,
          email: newUser.email,
          full_name: sanitizeText(newUser.full_name),
          phone: sanitizeText(newUser.phone),
          position: sanitizeText(newUser.position),
          company_name: sanitizeText(newUser.company_name),
          role: newUser.role,
          side: newUser.side,
          is_active: true
        })
        await logAudit(profile.id, 'create_user', 'profile', data.user.id)
      }

      setNewUser({ email: '', password: '', full_name: '', phone: '', position: '', company_name: '', role: 'user_fnu', side: 'FNU' })

      const { data: usersData } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
      safeSetState(setUsers)(usersData || [])

      addToast('Użytkownik utworzony / Користувача створено', 'success')
    } catch (err) { addToast('Błąd: ' + err.message, 'error') }
    setCreating(false)
  }

  const updateUser = async (userId, updates) => {
    await supabase.from('profiles').update(updates).eq('id', userId)
    await logAudit(profile.id, 'update_user', 'profile', userId, updates)

    const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
    safeSetState(setUsers)(data || [])

    addToast('Zaktualizowano / Оновлено', 'success')
  }

  if (loading) return <div className="loading">Ładowanie... / Завантаження...</div>

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal user-management wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="user-mgmt-title">
        <div className="modal-header">
          <h2 id="user-mgmt-title"><BiText pl="Zarządzanie użytkownikami" uk="Управління користувачами" /></h2>
          <button className="close-btn" onClick={onClose} aria-label="Zamknij">✕</button>
        </div>

        <div className="modal-body">
          <div className="add-user-section">
            <h4><BiText pl="Nowy użytkownik" uk="Новий користувач" /></h4>
            <form onSubmit={createUser} className="user-form">
              <div className="form-grid">
                <input placeholder="Email" type="email" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} required aria-label="Email" />
                <input placeholder="Hasło / Пароль" type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} required minLength={6} aria-label="Hasło" />
                <input placeholder="Imię i nazwisko / Ім'я" value={newUser.full_name} onChange={e => setNewUser({...newUser, full_name: e.target.value})} required aria-label="Imię i nazwisko" />
                <input placeholder="Telefon / Телефон" value={newUser.phone} onChange={e => setNewUser({...newUser, phone: e.target.value})} aria-label="Telefon" />
                <input placeholder="Stanowisko / Посада" value={newUser.position} onChange={e => setNewUser({...newUser, position: e.target.value})} aria-label="Stanowisko" />
                <input placeholder="Firma / Компанія" value={newUser.company_name} onChange={e => setNewUser({...newUser, company_name: e.target.value})} aria-label="Firma" />
                <select value={newUser.side} onChange={e => setNewUser({...newUser, side: e.target.value})} aria-label="Strona">
                  {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                </select>
                <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})} aria-label="Rola">
                  {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                </select>
              </div>
              <button type="submit" className="btn-primary" disabled={creating}>{creating ? '...' : 'Utwórz / Створити'}</button>
            </form>
          </div>

          <h4><BiText pl={`Lista użytkowników (${users.length})`} uk={`Список користувачів (${users.length})`} /></h4>
          <div className="users-table-container">
            <table className="users-table" aria-label="Lista użytkowników">
              <thead>
                <tr>
                  <th scope="col">Imię / Ім'я</th>
                  <th scope="col">Email</th>
                  <th scope="col">Telefon</th>
                  <th scope="col">Strona</th>
                  <th scope="col">Rola</th>
                  <th scope="col">Status</th>
                  <th scope="col">Akcje</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={u.is_active ? '' : 'inactive'}>
                    <td><SafeText>{u.full_name || '—'}</SafeText></td>
                    <td>{u.email}</td>
                    <td>{u.phone || '—'}</td>
                    <td>
                      <select value={u.side || 'FNU'} onChange={e => updateUser(u.id, { side: e.target.value })} className={`side-select ${u.side?.toLowerCase()}`} aria-label={`Strona dla ${u.email}`}>
                        {Object.entries(SIDES).map(([k]) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={u.role} onChange={e => updateUser(u.id, { role: e.target.value })} disabled={u.id === profile?.id} aria-label={`Rola dla ${u.email}`}>
                        {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                      </select>
                    </td>
                    <td><span className={`status-badge ${u.is_active ? 'active' : 'inactive'}`}>{u.is_active ? 'Aktywny' : 'Nieaktywny'}</span></td>
                    <td>
                      {u.id !== profile?.id && (
                        <button onClick={() => updateUser(u.id, { is_active: !u.is_active })} className={u.is_active ? 'btn-danger' : 'btn-success'} aria-label={u.is_active ? 'Dezaktywuj' : 'Aktywuj'}>
                          {u.is_active ? '🔒' : '🔓'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

// =====================================================
// AUDIT LOG COMPONENT
// =====================================================
function AuditLog({ onClose }) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [page, setPage] = useState(0)
  const [filter, setFilter] = useState('')
  const debouncedFilter = useDebounce(filter, 300)
  const modalRef = useRef(null)
  const safeSetState = useSafeAsync()
  const PAGE_SIZE = 60

  useFocusTrap(modalRef, true)

  const loadPage = useCallback(async (pageIndex = 0, append = false) => {
    const from = pageIndex * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data } = await supabase
      .from('audit_log')
      .select('*, user:user_id(full_name, email, side)')
      .order('created_at', { ascending: false })
      .range(from, to)

    const rows = data || []
    if (append) {
      safeSetState(setLogs)(prev => [...prev, ...rows])
    } else {
      safeSetState(setLogs)(rows)
    }
    safeSetState(setHasMore)(rows.length === PAGE_SIZE)
    safeSetState(setPage)(pageIndex)
  }, [safeSetState])

  useEffect(() => {
    const loadInitial = async () => {
      await loadPage(0, false)
      safeSetState(setLoading)(false)
    }
    loadInitial()
  }, [loadPage, safeSetState])

  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    await loadPage(page + 1, true)
    setLoadingMore(false)
  }

  const actionLabels = {
    'upload_file': '📤 Przesłanie pliku',
    'delete_file': '🗑️ Usunięcie pliku',
    'download_file': '⬇️ Pobranie pliku',
    'view_file': '👁️ Podgląd pliku',
    'view_document': '👁️ Podgląd dokumentu',
    'update_status': '🔄 Zmiana statusu',
    'add_comment': '💬 Dodanie komentarza',
    'create_user': '👤 Utworzenie użytkownika',
    'update_user': '✏️ Aktualizacja użytkownika'
  }

  const filtered = useMemo(() => {
    if (!debouncedFilter) return logs
    const lower = debouncedFilter.toLowerCase()
    return logs.filter(l => l.action?.includes(lower) || l.user?.email?.toLowerCase().includes(lower))
  }, [logs, debouncedFilter])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal audit-log wide" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="audit-title">
        <div className="modal-header">
          <h2 id="audit-title"><BiText pl="Dziennik audytu" uk="Журнал аудиту" /></h2>
          <button className="close-btn" onClick={onClose} aria-label="Zamknij">✕</button>
        </div>
        <div className="modal-body">
          <input type="search" placeholder="Filtr... / Фільтр..." value={filter} onChange={e => setFilter(e.target.value)} className="filter-input" aria-label="Filtruj logi" />
          {loading ? <div className="loading">...</div> : (
            <>
              <div className="audit-list" role="log">
                {filtered.map(log => (
                  <div key={log.id} className="audit-item">
                    <div className="audit-header">
                      <span className="audit-action">{actionLabels[log.action] || log.action}</span>
                      <time dateTime={log.created_at}>{new Date(log.created_at).toLocaleString()}</time>
                    </div>
                    <div className="audit-user">
                      <SafeText>{log.user?.full_name || log.user?.email || 'System'}</SafeText>
                      {log.user?.side && <span className={`side-badge ${log.user.side.toLowerCase()}`}>{log.user.side}</span>}
                    </div>
                    {log.details && <pre className="audit-details">{JSON.stringify(log.details, null, 2)}</pre>}
                  </div>
                ))}
              </div>
              <div className="audit-footer">
                <span>{logs.length} / {hasMore ? '...' : logs.length}</span>
                <button onClick={loadMore} disabled={!hasMore || loadingMore}>
                  {loadingMore ? '...' : 'Więcej / Більше'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// =====================================================
// DOCUMENT DETAIL MODAL
// =====================================================
function DocumentDetail({ document, onClose, onUpdate, displayLanguage }) {
  const [doc, setDoc] = useState(document)
  const [users, setUsers] = useState([])
  const modalRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()
  const safeSetState = useSafeAsync()

  const isSuperAdmin = profile?.role === 'super_admin'
  const isAdmin = isSuperAdmin || profile?.role === 'lawyer_admin'
  const canAdd = isAdmin || profile?.side === 'FNU'
  const canDelete = isAdmin
  const canComment = true
  const canView = true

  useFocusTrap(modalRef, true)

  useEffect(() => {
    const handleEsc = (e) => { if (e.key === 'Escape') onClose() }
    window.document.addEventListener('keydown', handleEsc)
    return () => window.document.removeEventListener('keydown', handleEsc)
  }, [onClose])

  useEffect(() => {
    supabase.from('profiles').select('id, full_name, email, side').eq('is_active', true).then(({ data }) => safeSetState(setUsers)(data || []))
    logAudit(profile?.id, 'view_document', 'document', document.id)
  }, [document.id, profile?.id, safeSetState])

  const updateStatus = async (status) => {
    await supabase.from('documents').update({ status, updated_at: new Date().toISOString() }).eq('id', doc.id)
    await logAudit(profile.id, 'update_status', 'document', doc.id, { status })
    setDoc({ ...doc, status })
    onUpdate?.()
    addToast('Status zaktualizowany / Статус оновлено', 'success')
  }

  const updateResponsible = async (userId) => {
    await supabase.from('documents').update({ responsible_user_id: userId || null, updated_at: new Date().toISOString() }).eq('id', doc.id)
    const user = users.find(u => u.id === userId)
    setDoc({ ...doc, responsible_user_id: userId, responsible: user })
    onUpdate?.()
    addToast('Odpowiedzialny zaktualizowany / Відповідального оновлено', 'success')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal document-detail" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="doc-title">
        <div className="modal-header">
          <div>
            <span className="doc-code">{doc.code}</span>
            <h3 id="doc-title" className="doc-title-pl"><SafeText>{doc.name_pl}</SafeText></h3>
            <p className="doc-title-uk"><SafeText>{doc.name_uk}</SafeText></p>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Zamknij">✕</button>
        </div>

        <div className="modal-body">
          <div className="doc-meta">
            <div className="meta-item">
              <label htmlFor="doc-status"><BiText pl="Status" uk="Статус" /></label>
              <select id="doc-status" value={doc.status || 'pending'} onChange={e => updateStatus(e.target.value)} disabled={!isAdmin}>
                {STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.pl} / {opt.uk}</option>)}
              </select>
            </div>
            <div className="meta-item">
              <label htmlFor="doc-responsible"><BiText pl="Odpowiedzialny" uk="Відповідальний" /></label>
              <select id="doc-responsible" value={doc.responsible_user_id || ''} onChange={e => updateResponsible(e.target.value)} disabled={!isAdmin}>
                <option value="">— Nie przypisano / Не призначено —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name || u.email} ({u.side})</option>)}
              </select>
            </div>
          </div>

          <ErrorBoundary>
            <FileUpload document={doc} onUpdate={onUpdate} canAdd={canAdd} canDelete={canDelete} canView={canView} />
          </ErrorBoundary>
          <ErrorBoundary>
            <Comments document={doc} canComment={canComment} canView={canView} displayLanguage={displayLanguage} />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}

// =====================================================
// SECTION MANAGER
// =====================================================
function SectionManager({ company, sections, onUpdate, onClose }) {
  const [newSection, setNewSection] = useState({ code: getNextSectionCode(sections), name_pl: '', name_uk: '' })
  const [parentSectionId, setParentSectionId] = useState('')
  const [allSections, setAllSections] = useState([])
  const [creating, setCreating] = useState(false)
  const modalRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()

  useFocusTrap(modalRef, true)

  useEffect(() => {
    setNewSection(prev => ({ ...prev, code: getNextSectionCode(sections) }))
  }, [sections])

  useEffect(() => {
    const loadAllSections = async () => {
      const { data } = await supabase
        .from('document_sections')
        .select('id, parent_section_id, code, name_pl, name_uk, order_index')
        .eq('company_id', company.id)
        .order('order_index')
      setAllSections(data || [])
    }
    loadAllSections()
  }, [company.id, sections])

  const createSection = async (e) => {
    e.preventDefault()
    setCreating(true)
    const { error } = await supabase.from('document_sections').insert({
      company_id: company.id,
      code: sanitizeText(newSection.code || getNextSectionCode(sections)),
      name_pl: sanitizeText(newSection.name_pl),
      name_uk: sanitizeText(newSection.name_uk),
      parent_section_id: parentSectionId || null,
      order_index: sections.length + 1,
      created_by: profile.id
    })

    if (!error) {
      setNewSection({ code: getNextSectionCode(sections), name_pl: '', name_uk: '' })
      setParentSectionId('')
      onUpdate()
      addToast('Sekcja utworzona / Розділ створено', 'success')
    }
    setCreating(false)
  }

  const deleteSection = async (sectionId) => {
    if (!confirm('Usunąć sekcję? / Видалити розділ?')) return
    await supabase.from('document_sections').delete().eq('id', sectionId)
    onUpdate()
    addToast('Sekcja usunięta / Розділ видалено', 'success')
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal section-manager" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2><BiText pl="Zarządzanie sekcjami" uk="Управління розділами" /></h2>
          <button className="close-btn" onClick={onClose} aria-label="Zamknij">✕</button>
        </div>
        <div className="modal-body">
          <form onSubmit={createSection} className="section-form">
            <input placeholder="Kod auto" value={newSection.code} readOnly maxLength={10} aria-label="Kod sekcji (auto)" />
            <input placeholder="Nazwa (PL)" value={newSection.name_pl} onChange={e => setNewSection({...newSection, name_pl: e.target.value})} required aria-label="Nazwa polska" />
            <input placeholder="Назва (UK)" value={newSection.name_uk} onChange={e => setNewSection({...newSection, name_uk: e.target.value})} required aria-label="Nazwa ukraińska" />
            <select value={parentSectionId} onChange={e => setParentSectionId(e.target.value)} aria-label="Sekcja nadrzędna">
              <option value="">Folder główny / Головна папка</option>
              {(allSections || []).map(s => (
                <option key={s.id} value={s.id}>{s.code} {s.name_pl}</option>
              ))}
            </select>
            <button type="submit" disabled={creating}>{creating ? '...' : '+ Dodaj / Додати'}</button>
          </form>

          <div className="sections-list">
            {(allSections.length ? allSections : sections).map(s => (
              <div key={s.id} className="section-item">
                <span className="section-code">{s.code}</span>
                <span className="section-name"><SafeText>{s.name_pl}</SafeText> / <SafeText>{s.name_uk}</SafeText></span>
                <button onClick={() => deleteSection(s.id)} className="btn-danger" aria-label={`Usuń sekcję ${s.code}`}>🗑️</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// =====================================================
// NOTIFICATIONS BELL
// =====================================================
function NotificationsBell() {
  const [notifications, setNotifications] = useState([])
  const [showDropdown, setShowDropdown] = useState(false)
  const profile = useProfile()
  const safeSetState = useSafeAsync()
  const channelRef = useRef(null)

  useEffect(() => {
    const load = async () => {
      if (!profile?.id) return
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .eq('user_id', profile.id)
        .eq('is_read', false)
        .order('created_at', { ascending: false })
        .limit(10)
      safeSetState(setNotifications)(data || [])
    }
    load()

    if (profile?.id && isValidUUID(profile.id)) {
      channelRef.current = supabase
        .channel(`notifications_${profile.id}`)
        .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'notifications' },
          (payload) => {
            if (payload.new.user_id === profile.id) {
              load()
            }
          }
        )
        .subscribe()
    }

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current)
      }
    }
  }, [profile?.id, safeSetState])

  const markAsRead = async (id) => {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id)
    setNotifications(prev => prev.filter(n => n.id !== id))
  }

  const markAllRead = async () => {
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', profile.id)
    setNotifications([])
  }

  return (
    <div className="notifications-bell">
      <button
        onClick={() => setShowDropdown(!showDropdown)}
        className="bell-btn"
        aria-label={`Powiadomienia (${notifications.length} nieprzeczytanych)`}
        aria-expanded={showDropdown}
        aria-haspopup="true"
      >
        🔔 {notifications.length > 0 && <span className="badge" aria-hidden="true">{notifications.length}</span>}
      </button>
      {showDropdown && (
        <div className="notifications-dropdown" role="menu" aria-label="Powiadomienia">
          <div className="notif-header">
            <BiText pl="Powiadomienia" uk="Сповіщення" />
            {notifications.length > 0 && <button onClick={markAllRead}>✓ Wszystko</button>}
          </div>
          {notifications.length === 0 ? (
            <div className="no-notif"><BiText pl="Brak powiadomień" uk="Немає сповіщень" /></div>
          ) : (
            notifications.map(n => (
              <div key={n.id} className="notif-item" onClick={() => markAsRead(n.id)} role="menuitem" tabIndex={0} onKeyPress={e => e.key === 'Enter' && markAsRead(n.id)}>
                <strong><SafeText>{n.title}</SafeText></strong>
                <p><SafeText>{n.message}</SafeText></p>
                <time dateTime={n.created_at}>{new Date(n.created_at).toLocaleString()}</time>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function SmartInbox({ documents, profile }) {
  const critical = useMemo(() => (documents || []).filter(d => d.status === 'missing'), [documents])
  const inProgress = useMemo(() => (documents || []).filter(d => d.status === 'in_progress'), [documents])
  const unassigned = useMemo(() => (documents || []).filter(d => !d.responsible_user_id), [documents])
  const myDocs = useMemo(() => (documents || []).filter(d => d.responsible_user_id === profile?.id), [documents, profile?.id])

  const cards = [
    { id: 'critical', titlePl: 'Krytyczne braki', titleUk: 'Критичні відсутності', value: critical.length, tone: 'danger' },
    { id: 'progress', titlePl: 'W trakcie', titleUk: 'В роботі', value: inProgress.length, tone: 'warning' },
    { id: 'unassigned', titlePl: 'Bez odpowiedzialnego', titleUk: 'Без відповідального', value: unassigned.length, tone: 'muted' },
    { id: 'mine', titlePl: 'Moje dokumenty', titleUk: 'Мої документи', value: myDocs.length, tone: 'success' }
  ]

  return (
    <section className="smart-inbox" aria-label="Smart Inbox">
      <h4><BiText pl="Priorytety dnia" uk="Пріоритети дня" /></h4>
      <div className="inbox-grid">
        {cards.map(card => (
          <article key={card.id} className={`inbox-card ${card.tone}`}>
            <span className="inbox-value">{card.value}</span>
            <span className="inbox-label">
              <span className="text-pl">{card.titlePl}</span>
              <span className="text-uk">{card.titleUk}</span>
            </span>
          </article>
        ))}
      </div>
    </section>
  )
}

function InlineDocumentDrawer({ document, onUpdate, displayLanguage }) {
  const profile = useProfile()
  const isSuperAdmin = profile?.role === 'super_admin'
  const isAdmin = isSuperAdmin || profile?.role === 'lawyer_admin'
  const canAdd = isAdmin || profile?.side === 'FNU'
  const canDelete = isAdmin
  const canComment = true
  const canView = true

  return (
    <div className="inline-doc-drawer">
      <div className="inline-doc-meta">
        <span className="doc-code">{document.code}</span>
        <strong><SafeText>{document.name_pl}</SafeText></strong>
        <span><SafeText>{document.name_uk}</SafeText></span>
      </div>
      <div className="inline-doc-panels">
        <ErrorBoundary>
          <FileUpload document={document} onUpdate={onUpdate} canAdd={canAdd} canDelete={canDelete} canView={canView} />
        </ErrorBoundary>
        <ErrorBoundary>
          <Comments document={document} canComment={canComment} canView={canView} displayLanguage={displayLanguage} />
        </ErrorBoundary>
      </div>
    </div>
  )
}

// =====================================================
// MAIN APP COMPONENT
// =====================================================
function AppContent() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState([])
  const [selectedCompany, setSelectedCompany] = useState(null)
  const [sections, setSections] = useState([])
  const [activeSection, setActiveSection] = useState(null)
  const [documents, setDocuments] = useState([])
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [expandedDocId, setExpandedDocId] = useState(null)
  const [showUserManagement, setShowUserManagement] = useState(false)
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [showSectionManager, setShowSectionManager] = useState(false)
  const [docSearch, setDocSearch] = useState('')
  const [docStatusFilter, setDocStatusFilter] = useState('all')
  const [docFileStats, setDocFileStats] = useState({})
  const [newDocument, setNewDocument] = useState({ code: '', name_pl: '', name_uk: '' })
  const [creatingDocument, setCreatingDocument] = useState(false)
  const [chatLanguageMode, setChatLanguageMode] = useState(() => {
    if (typeof window === 'undefined') return 'auto'
    const cached = window.localStorage.getItem('chat_display_language')
    return LANGUAGE_MODES.includes(cached) ? cached : 'auto'
  })
  const [chatContextSeed, setChatContextSeed] = useState(null)
  const [chatInitialDraft, setChatInitialDraft] = useState('')
  const addToast = useToast()
  const safeSetState = useSafeAsync()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session) loadProfile(data.session.user.id)
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setSession(session)
      if (session) loadProfile(session.user.id)
      else { setProfile(null); setLoading(false) }
    })
    return () => subscription?.unsubscribe()
  }, [])

  const loadProfile = async (userId) => {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
    safeSetState(setProfile)(data)
    loadCompanies()
  }

  const loadCompanies = async () => {
    const { data } = await supabase.from('companies').select('*').order('order_index')
    safeSetState(setCompanies)(data || [])
    if (data?.length > 0) safeSetState(setSelectedCompany)(data[0])
    safeSetState(setLoading)(false)
  }

  const loadSections = useCallback(async () => {
    if (!selectedCompany) return
    const { data } = await supabase.from('document_sections').select('*').eq('company_id', selectedCompany.id).is('parent_section_id', null).order('order_index')
    safeSetState(setSections)(data || [])
    if (data?.length > 0 && !activeSection) safeSetState(setActiveSection)(data[0])
  }, [selectedCompany, activeSection, safeSetState])

  useEffect(() => { if (selectedCompany) loadSections() }, [selectedCompany, loadSections])

  const loadDocuments = useCallback(async () => {
    if (!activeSection) return
    const { data: subSections } = await supabase.from('document_sections').select('id').eq('parent_section_id', activeSection.id)
    const sectionIds = [activeSection.id, ...(subSections || []).map(s => s.id)]

    const { data } = await supabase
      .from('documents')
      .select('*, responsible:profiles!documents_responsible_user_id_fkey(full_name, email, side)')
      .in('section_id', sectionIds)
      .order('order_index')
    const docs = data || []
    safeSetState(setDocuments)(docs)

    const ids = docs.map(d => d.id).filter(isValidUUID)
    if (ids.length === 0) {
      safeSetState(setDocFileStats)({})
      return
    }
    let { data: fileRows, error: fileStatsError } = await supabase
      .from('document_files')
      .select('document_id, created_at, uploaded_at')
      .in('document_id', ids)
    if (fileStatsError && /uploaded_at/i.test(fileStatsError.message || '')) {
      const fallback = await supabase
        .from('document_files')
        .select('document_id, created_at')
        .in('document_id', ids)
      fileRows = fallback.data
      fileStatsError = fallback.error
    }
    if (fileStatsError) {
      safeSetState(setDocFileStats)({})
      return
    }
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const stats = {}
    ids.forEach(id => { stats[id] = { total: 0, newToday: 0 } })
    ;(fileRows || []).forEach(row => {
      const docId = row.document_id
      if (!stats[docId]) stats[docId] = { total: 0, newToday: 0 }
      stats[docId].total += 1
      const created = row.created_at || row.uploaded_at
      if (created && new Date(created) >= startOfDay) stats[docId].newToday += 1
    })
    safeSetState(setDocFileStats)(stats)
  }, [activeSection, safeSetState])

  useEffect(() => { if (activeSection) loadDocuments() }, [activeSection, loadDocuments])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!LANGUAGE_MODES.includes(chatLanguageMode)) return
    window.localStorage.setItem('chat_display_language', chatLanguageMode)
  }, [chatLanguageMode])

  const updateStatus = async (docId, status) => {
    if (!isValidUUID(docId)) return
    await supabase.from('documents').update({ status, updated_at: new Date().toISOString() }).eq('id', docId)
    await logAudit(profile.id, 'update_status', 'document', docId, { status })
    loadDocuments()
  }

  const createDocument = async (e) => {
    e.preventDefault()
    if (!activeSection?.id) return
    setCreatingDocument(true)
    try {
      const payload = {
        section_id: activeSection.id,
        code: sanitizeText(newDocument.code),
        name_pl: sanitizeText(newDocument.name_pl),
        name_uk: sanitizeText(newDocument.name_uk),
        status: 'pending',
        order_index: (documents?.length || 0) + 1,
        created_by: profile.id
      }
      const { error } = await supabase.from('documents').insert(payload)
      if (error) throw error
      await logAudit(profile.id, 'create_document', 'document', null, { section_id: activeSection.id, code: payload.code })
      setNewDocument({ code: '', name_pl: '', name_uk: '' })
      addToast('Dokument utworzony / Документ створено', 'success')
      loadDocuments()
    } catch (err) {
      addToast(`Błąd dokumentu: ${sanitizeText(err?.message || 'create_failed')}`, 'error')
    } finally {
      setCreatingDocument(false)
    }
  }

  if (loading) return <div className="loading" role="status" aria-live="polite">Ładowanie... / Завантаження...</div>
  if (!session) return <Auth />
  if (!profile) return <div className="loading" role="status" aria-live="polite">Ładowanie profilu... / Завантаження профілю...</div>

  const isSuperAdmin = profile.role === 'super_admin'
  const isAdmin = isSuperAdmin || profile.role === 'lawyer_admin'
  const q = docSearch.trim().toLowerCase()
  const filteredDocuments = documents.filter(doc => {
    const byStatus = docStatusFilter === 'all' ? true : (doc.status || 'pending') === docStatusFilter
    const bySearch = !q
      ? true
      : [doc.code, doc.name_pl, doc.name_uk].some(v => (v || '').toLowerCase().includes(q))
    return byStatus && bySearch
  })
  const totalDocs = filteredDocuments.length
  const completedDocs = filteredDocuments.filter(d => d.status === 'done').length
  const progress = totalDocs > 0 ? Math.round((completedDocs / totalDocs) * 100) : 0
  const sectionFileStats = filteredDocuments.reduce((acc, doc) => {
    const stat = docFileStats[doc.id] || { total: 0, newToday: 0 }
    acc.total += stat.total
    acc.newToday += stat.newToday
    return acc
  }, { total: 0, newToday: 0 })

  const startDiscussionFromDocument = (doc) => {
    if (!doc?.id || !selectedCompany?.id || !activeSection?.id) return
    const topic = `${doc.code} ${doc.name_pl}`
    setChatContextSeed({
      companyId: selectedCompany.id,
      sectionId: activeSection.id,
      documentId: doc.id,
      topic
    })
    setChatInitialDraft(`Pytanie dot. ${doc.code} / Питання щодо ${doc.code}: `)
  }

  const toggleDocumentDrawer = (docId) => {
    setExpandedDocId(prev => (prev === docId ? null : docId))
  }

  return (
    <ProfileContext.Provider value={profile}>
      <div className="app">
        <a href="#main-content" className="skip-link">Przejdź do treści / Перейти до змісту</a>

        <header role="banner">
          <div className="header-left">
            <div className="brand-stack">
              <h1>Foundation Unbreakable Ukraine</h1>
              <small>Audit System</small>
            </div>
            <select value={selectedCompany?.id || ''} onChange={e => setSelectedCompany(companies.find(c => c.id === e.target.value))} aria-label="Wybierz firmę">
              {companies.map(c => <option key={c.id} value={c.id}>{c.name_pl} / {c.name_uk}</option>)}
            </select>
          </div>

          <div className="header-right">
            <div className="user-info">
              <span className="user-name"><SafeText>{profile.full_name || profile.email}</SafeText></span>
              <span className={`side-badge ${profile.side?.toLowerCase()}`}>{profile.side}</span>
              <span className="role-badge">{ROLES[profile.role]?.pl}</span>
            </div>

            <NotificationsBell />

            {isSuperAdmin && (
              <>
                <button onClick={() => setShowUserManagement(true)} aria-label="Zarządzanie użytkownikami">👥</button>
                <button onClick={() => setShowAuditLog(true)} aria-label="Dziennik audytu">📜</button>
                <button onClick={() => setShowSectionManager(true)} aria-label="Zarządzanie sekcjami">📁</button>
              </>
            )}

            <button onClick={() => supabase.auth.signOut()} aria-label="Wyloguj">🚪</button>
          </div>
        </header>

        <div
          className="progress-bar"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuetext={`${completedDocs} z ${totalDocs} dokumentów ukończonych (${progress}%)`}
        >
          <div className="progress-track"><div className="progress" style={{ width: `${progress}%` }} /></div>
          <span>{completedDocs} / {totalDocs} ({progress}%)</span>
        </div>

        <nav className="sections-nav" aria-label="Sekcje dokumentów" role="tablist">
          {sections.map(s => (
            <button
              key={s.id}
              className={activeSection?.id === s.id ? 'active' : ''}
              onClick={() => setActiveSection(s)}
              role="tab"
              aria-selected={activeSection?.id === s.id}
              aria-controls="main-content"
            >
              <span className="section-code">{s.code}.</span>
              <span className="section-name-pl"><SafeText>{s.name_pl}</SafeText></span>
              <span className="section-name-uk"><SafeText>{s.name_uk}</SafeText></span>
            </button>
          ))}
        </nav>

        <div className="workspace-layout">
          <main id="main-content" role="tabpanel" className="content-pane">
            <div className="section-header">
              <h2>
                <span className="code">{activeSection?.code}.</span>
                <span className="name-pl"><SafeText>{activeSection?.name_pl}</SafeText></span>
                <span className="name-uk"><SafeText>{activeSection?.name_uk}</SafeText></span>
              </h2>
            </div>

            <div className="context-toolbar">
              <div className="context-chip">
                <BiText pl="Kontekst sekcji" uk="Контекст секції" />
                <strong><SafeText>{activeSection?.name_pl || '—'}</SafeText></strong>
              </div>
              <div className="context-chip">
                <BiText pl="Filtr statusu" uk="Фільтр статусу" />
                <select value={docStatusFilter} onChange={e => setDocStatusFilter(e.target.value)} aria-label="Filtr statusu">
                  <option value="all">Wszystkie / Усі</option>
                  {STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.pl} / {opt.uk}</option>)}
                </select>
              </div>
              <div className="context-chip">
                <BiText pl="Pliki w sekcji" uk="Файли у секції" />
                <strong>{sectionFileStats.total}</strong>
                <small>Nowe dziś / Нові сьогодні: {sectionFileStats.newToday}</small>
              </div>
              <div className="context-chip search">
                <BiText pl="Szukaj dokumentu" uk="Пошук документа" />
                <input
                  type="search"
                  value={docSearch}
                  onChange={e => setDocSearch(e.target.value)}
                  placeholder="Kod, nazwa... / Код, назва..."
                  aria-label="Szukaj dokumentu"
                />
              </div>
            </div>

            {isAdmin && (
              <form className="doc-create-form" onSubmit={createDocument}>
                <input
                  value={newDocument.code}
                  onChange={e => setNewDocument(prev => ({ ...prev, code: e.target.value }))}
                  placeholder="Kod dokumentu / Код документа"
                  required
                  maxLength={24}
                />
                <input
                  value={newDocument.name_pl}
                  onChange={e => setNewDocument(prev => ({ ...prev, name_pl: e.target.value }))}
                  placeholder="Nazwa dokumentu (PL)"
                  required
                />
                <input
                  value={newDocument.name_uk}
                  onChange={e => setNewDocument(prev => ({ ...prev, name_uk: e.target.value }))}
                  placeholder="Назва документа (UK)"
                  required
                />
                <button type="submit" disabled={creatingDocument}>
                  {creatingDocument ? '...' : '+ Dokument / + Документ'}
                </button>
              </form>
            )}

            <div className="documents-list" role="list" aria-label="Lista dokumentów">
              {filteredDocuments.map(doc => (
                <div key={doc.id} className="doc-row">
                  <article
                    className={`doc-item ${doc.status || 'pending'}`}
                    onClick={() => toggleDocumentDrawer(doc.id)}
                    tabIndex={0}
                    onKeyPress={e => e.key === 'Enter' && toggleDocumentDrawer(doc.id)}
                    role="listitem"
                    aria-label={`${doc.code} - ${doc.name_pl}`}
                  >
                    <div className="doc-info">
                      <span className="doc-code">{doc.code}</span>
                      <div className="doc-names">
                      <span className="name-pl"><SafeText>{doc.name_pl}</SafeText></span>
                      <span className="name-uk"><SafeText>{doc.name_uk}</SafeText></span>
                      <span className="doc-file-stats">
                        📎 {(docFileStats[doc.id]?.total || 0)} | 🆕 {(docFileStats[doc.id]?.newToday || 0)}
                      </span>
                    </div>
                  </div>
                    {doc.responsible && (
                      <span className="doc-responsible">
                        <SafeText>{doc.responsible.full_name || doc.responsible.email}</SafeText>
                        <span className={`side-badge small ${doc.responsible.side?.toLowerCase()}`}>{doc.responsible.side}</span>
                      </span>
                    )}
                    <button
                      type="button"
                      className="doc-chat-btn"
                      onClick={e => {
                        e.stopPropagation()
                        startDiscussionFromDocument(doc)
                      }}
                      aria-label={`Omów dokument ${doc.code}`}
                    >
                      💬 Omów / Обговорити
                    </button>
                    <button
                      type="button"
                      className="doc-detail-btn"
                      onClick={e => {
                        e.stopPropagation()
                        setSelectedDocument(doc)
                      }}
                      aria-label={`Szczegóły dokumentu ${doc.code}`}
                    >
                      🗂️ Pliki
                    </button>
                    <select
                      value={doc.status || 'pending'}
                      onChange={e => { e.stopPropagation(); updateStatus(doc.id, e.target.value) }}
                      onClick={e => e.stopPropagation()}
                      disabled={!isAdmin}
                      aria-label={`Status dokumentu ${doc.code}`}
                    >
                      {STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.pl}</option>)}
                    </select>
                  </article>
                  {expandedDocId === doc.id && (
                    <InlineDocumentDrawer
                      document={doc}
                      onUpdate={loadDocuments}
                      displayLanguage={resolveLanguageMode(chatLanguageMode, profile?.side)}
                    />
                  )}
                </div>
              ))}
              {filteredDocuments.length === 0 && <div className="no-docs"><BiText pl="Brak dokumentów" uk="Немає документів" /></div>}
            </div>
          </main>

          <aside className="right-rail" aria-label="Panel boczny / Бічна панель">
            <SmartInbox documents={documents} profile={profile} />
            <ErrorBoundary>
              <Chat
                displayLanguageMode={chatLanguageMode}
                onDisplayLanguageModeChange={setChatLanguageMode}
                contextHint={
                  selectedDocument
                    ? `${selectedDocument.code} ${selectedDocument.name_pl}`
                    : activeSection
                      ? `${activeSection.code} ${activeSection.name_pl}`
                      : ''
                }
                contextSeed={chatContextSeed}
                initialMessageDraft={chatInitialDraft}
                onDraftConsumed={() => setChatInitialDraft('')}
                companies={companies}
                selectedCompanyId={selectedCompany?.id}
                activeSectionId={activeSection?.id}
              />
            </ErrorBoundary>
          </aside>
        </div>

        {showUserManagement && (
          <ErrorBoundary>
            <UserManagement onClose={() => setShowUserManagement(false)} />
          </ErrorBoundary>
        )}
        {showAuditLog && (
          <ErrorBoundary>
            <AuditLog onClose={() => setShowAuditLog(false)} />
          </ErrorBoundary>
        )}
        {showSectionManager && selectedCompany && (
          <ErrorBoundary>
            <SectionManager company={selectedCompany} sections={sections} onUpdate={loadSections} onClose={() => setShowSectionManager(false)} />
          </ErrorBoundary>
        )}
        {selectedDocument && (
          <ErrorBoundary>
            <DocumentDetail
              document={selectedDocument}
              onClose={() => setSelectedDocument(null)}
              onUpdate={loadDocuments}
              displayLanguage={resolveLanguageMode(chatLanguageMode, profile?.side)}
            />
          </ErrorBoundary>
        )}
      </div>
    </ProfileContext.Provider>
  )
}

// =====================================================
// APP WITH ERROR BOUNDARY & PROVIDERS
// =====================================================
export default function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppContent />
      </ToastProvider>
    </ErrorBoundary>
  )
}
