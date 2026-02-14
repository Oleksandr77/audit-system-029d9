import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext, Component } from 'react'
import { supabase } from './lib/supabase'
import JSZip from 'jszip'

// =====================================================
// CONSTANTS
// =====================================================
const ROLES = {
  super_admin: { pl: 'Super Admin', uk: 'Супер Адмін' },
  lawyer_admin: { pl: 'Prawnik Admin', uk: 'Юрист Адмін' },
  lawyer_auditor: { pl: 'Prawnik Audytor', uk: 'Юрист Аудитор' },
  user_fnu: { pl: 'Użytkownik FNU', uk: 'Користувач FNU' },
  user_operator: { pl: 'Użytkownik AUDITOR', uk: 'Користувач AUDITOR' }
}

// Canonical side name is AUDITOR. OPERATOR is legacy (kept for backward compatibility with old DB rows).
const SIDE_FNU = 'FNU'
const SIDE_AUDITOR = 'AUDITOR'
const SIDE_OPERATOR_LEGACY = 'OPERATOR'

const SIDES = {
  [SIDE_FNU]: { pl: 'FNU (Strona dostarczająca)', uk: 'FNU (Сторона що надає)' },
  [SIDE_AUDITOR]: { pl: 'AUDITOR (Strona audytu)', uk: 'AUDITOR (Сторона аудиту)' }
}

function normalizeSide(side) {
  const s = String(side || '').trim().toUpperCase()
  if (s === SIDE_OPERATOR_LEGACY) return SIDE_AUDITOR
  if (s === SIDE_FNU) return SIDE_FNU
  if (s === SIDE_AUDITOR) return SIDE_AUDITOR
  return s || SIDE_FNU
}

function isAuditorSide(side) {
  return normalizeSide(side) === SIDE_AUDITOR
}

function formatSideLabel(side) {
  const s = normalizeSide(side)
  return s === SIDE_AUDITOR ? SIDE_AUDITOR : SIDE_FNU
}

function sideClass(side) {
  const s = normalizeSide(side)
  return s === SIDE_AUDITOR ? 'auditor' : 'fnu'
}

function visibleSidesHasAuditor(visibleToSides) {
  const list = Array.isArray(visibleToSides) ? visibleToSides : []
  return list.some(s => normalizeSide(s) === SIDE_AUDITOR)
}

function canSeeBySide(visibleToSides, viewerSide) {
  const viewer = normalizeSide(viewerSide)
  const list = Array.isArray(visibleToSides) ? visibleToSides : []
  if (list.length === 0) return true
  if (viewer === SIDE_FNU) return list.some(s => normalizeSide(s) === SIDE_FNU)
  return list.some(s => normalizeSide(s) === SIDE_AUDITOR)
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
const SIDE_DEFAULT_LANGUAGE = { [SIDE_FNU]: 'uk', [SIDE_AUDITOR]: 'pl', [SIDE_OPERATOR_LEGACY]: 'pl' }
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

const COMMENT_AUTHOR_PALETTE = [
  { bg: '#fff5f7', border: '#f9a8d4', accent: '#9d174d' },
  { bg: '#f5f3ff', border: '#c4b5fd', accent: '#5b21b6' },
  { bg: '#eff6ff', border: '#93c5fd', accent: '#1d4ed8' },
  { bg: '#ecfeff', border: '#67e8f9', accent: '#0e7490' },
  { bg: '#ecfdf5', border: '#86efac', accent: '#166534' },
  { bg: '#fffbeb', border: '#fcd34d', accent: '#92400e' },
  { bg: '#fff7ed', border: '#fdba74', accent: '#9a3412' },
  { bg: '#f8fafc', border: '#cbd5e1', accent: '#334155' },
]

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

function GoogleDriveIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M7.2 2.4h9.6l4.8 8.4h-9.6z" fill="#0f9d58" />
      <path d="M2.4 10.8l4.8-8.4 4.8 8.4-4.8 8.4z" fill="#34a853" />
      <path d="M12 19.2l4.8-8.4h9.6l-4.8 8.4z" fill="#fbbc04" transform="translate(-2.4 0)" />
      <path d="M2.4 10.8h9.6l4.8 8.4h-9.6z" fill="#4285f4" />
    </svg>
  )
}

function LocalUploadIcon({ className = '' }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 3l4 4h-3v6h-2V7H8z" fill="#174454" />
      <path d="M5 14h14v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z" fill="#2b6b82" />
      <path d="M6 14h12" stroke="#fff" strokeWidth="1.5" />
    </svg>
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

function hashStringToIndex(value, modulo) {
  const input = String(value || '')
  let hash = 0
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % Math.max(1, modulo)
}

function getCommentAuthorTone(authorKey) {
  const idx = hashStringToIndex(authorKey || 'unknown', COMMENT_AUTHOR_PALETTE.length)
  return COMMENT_AUTHOR_PALETTE[idx]
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

async function parseFunctionsInvokeError(err) {
  const fallback = String(err?.message || 'request_failed')
  const context = err?.context
  if (!context || typeof context.clone !== 'function') return fallback
  try {
    const jsonPayload = await context.clone().json().catch(() => null)
    if (jsonPayload && typeof jsonPayload === 'object') {
      const runId = jsonPayload?.run_id ? ` | run_id=${String(jsonPayload.run_id)}` : ''
      const msg = jsonPayload?.error || jsonPayload?.message || jsonPayload?.msg
      if (msg) return `${String(msg)}${runId}`
    }
  } catch {}
  try {
    const textPayload = await context.clone().text()
    if (textPayload) return String(textPayload)
  } catch {}
  return fallback
}

async function invokeFunctionWithAuthRetry(functionName, payload) {
  const readAccessToken = async () => {
    const { data: sessionData, error: sessionErr } = await supabase.auth.getSession()
    if (sessionErr) throw new Error(sessionErr.message || 'Failed to read auth session')
    const token = sessionData?.session?.access_token
    if (!token) throw new Error('No active auth session. Please sign in again.')
    return token
  }

  let accessToken = await readAccessToken()
  let result = await supabase.functions.invoke(functionName, {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: payload,
  })
  if (!result.error) return result

  const details = await parseFunctionsInvokeError(result.error)
  if (!/invalid jwt/i.test(details)) return result

  const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
  if (refreshErr || !refreshed?.session?.access_token) {
    return result
  }

  accessToken = refreshed.session.access_token
  result = await supabase.functions.invoke(functionName, {
    headers: { Authorization: `Bearer ${accessToken}` },
    body: payload,
  })
  return result
}

async function invokeGdriveImportWithAuthRetry(payload) {
  return invokeFunctionWithAuthRetry('gdrive-import', payload)
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

  let lastError = null
  for (let attempt = 0; attempt < LLM_MAX_RETRIES; attempt++) {
    try {
      const { data, error } = await callWithTimeout(
        supabase.functions.invoke('llm-translator', {
          body: {
            mode: 'translate',
            source_language: source,
            target_language: target,
            text,
            strict: true,
            system_instruction: 'Professional native-level translation for audit/business context. Keep exact meaning, tone, names, dates, numbers and punctuation. No explanations, no notes, output translated text only.'
          }
        }),
        TRANSLATION_TIMEOUT_MS
      )
      if (error) throw error
      const translated = sanitizeText(data?.translated_text || '')
      if (!translated) throw new Error('empty_translation')
      setCachedValue(translateCache, cacheKey, translated)
      return translated
    } catch (error) {
      lastError = error
      if (attempt < LLM_MAX_RETRIES - 1) {
        const backoffMs = 250 * Math.pow(2, attempt)
        await new Promise(resolve => setTimeout(resolve, backoffMs))
      }
    }
  }
  throw new Error(`translation_failed: ${String(lastError?.message || 'unknown_error')}`)
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
  const [oauthLoading, setOauthLoading] = useState('')
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

  const handleOAuth = async (provider) => {
    setError('')
    setOauthLoading(provider)
    try {
      const redirectTo = `${window.location.origin}${window.location.pathname}`
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo }
      })
      if (error) throw error
    } catch (err) {
      setError(err.message || 'OAuth login failed')
      setOauthLoading('')
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-stage-decor" aria-hidden="true">
        <span className="glow g1" />
        <span className="glow g2" />
        <span className="glow g3" />
        <span className="beam b1" />
        <span className="beam b2" />
        <span className="beam b3" />
        <span className="grain" />
      </div>
      <div className="auth-shell">
        <aside className="auth-hero" aria-label="FNU education visual">
          <div className="auth-premium-canvas" aria-hidden="true">
            <div className="premium-panel panel-a" />
            <div className="premium-panel panel-b" />
            <div className="premium-panel panel-c" />
            <div className="auth-watermark">
              <svg viewBox="0 0 100 100">
                <polygon points="50,7 82,25 82,62 50,81 18,62 18,25" />
                <circle cx="50" cy="44" r="12" />
              </svg>
            </div>
          </div>

          <div className="auth-hero-content">
            <div className="auth-heading-card">
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
            </div>

            <div className="auth-hero-grid" aria-label="Education themed visual grid">
              <div className="auth-scene-card scene-school">
                <span className="scene-beam" aria-hidden="true" />
                <svg className="scene-illustration" viewBox="0 0 220 120" aria-hidden="true">
                  <path d="M22 56 L110 20 L198 56 L110 90 Z" />
                  <path d="M42 60 L42 104 L178 104 L178 60" />
                  <path d="M110 60 L110 104" />
                  <path d="M82 72 L82 104" />
                  <path d="M138 72 L138 104" />
                  <circle cx="110" cy="44" r="9" />
                </svg>
              </div>
              <div className="auth-scene-card scene-students">
                <span className="scene-beam" aria-hidden="true" />
                <svg className="scene-illustration" viewBox="0 0 220 120" aria-hidden="true">
                  <circle cx="112" cy="38" r="13" />
                  <path d="M72 92 Q112 52 152 92" />
                  <path d="M86 34 L112 19 L138 34 L112 46 Z" />
                  <path d="M138 34 L156 46" />
                  <path d="M54 96 L168 96" />
                </svg>
              </div>
              <div className="auth-scene-card scene-online">
                <span className="scene-beam" aria-hidden="true" />
                <svg className="scene-illustration" viewBox="0 0 220 120" aria-hidden="true">
                  <rect x="52" y="24" width="116" height="54" rx="7" />
                  <path d="M36 90 L184 90" />
                  <path d="M70 82 L150 82" />
                  <path d="M96 68 L124 68" />
                </svg>
              </div>
              <div className="auth-scene-card scene-subjects">
                <span className="scene-beam" aria-hidden="true" />
                <svg className="scene-illustration" viewBox="0 0 220 120" aria-hidden="true">
                  <rect x="62" y="20" width="24" height="76" rx="4" />
                  <rect x="96" y="16" width="24" height="80" rx="4" />
                  <rect x="130" y="24" width="24" height="72" rx="4" />
                  <path d="M56 96 L160 96" />
                </svg>
              </div>
              <div className="auth-scene-card scene-lab">
                <span className="scene-beam" aria-hidden="true" />
                <svg className="scene-illustration" viewBox="0 0 220 120" aria-hidden="true">
                  <path d="M100 24 L120 24" />
                  <path d="M106 24 L106 52 L88 84 Q86 90 92 94 L128 94 Q134 90 132 84 L114 52 L114 24" />
                  <path d="M94 74 Q110 66 126 74" />
                </svg>
              </div>
              <div className="auth-scene-card scene-docs">
                <span className="scene-beam" aria-hidden="true" />
                <svg className="scene-illustration" viewBox="0 0 220 120" aria-hidden="true">
                  <rect x="62" y="26" width="66" height="72" rx="6" />
                  <path d="M78 52 L112 52" />
                  <path d="M78 64 L112 64" />
                  <path d="M78 76 L104 76" />
                  <rect x="118" y="34" width="40" height="54" rx="6" />
                </svg>
              </div>
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
            <button type="submit" className="auth-submit-btn" disabled={loading || Boolean(oauthLoading)}>
              {loading ? '...' : 'Zaloguj / Увійти'}
            </button>
          </form>
          <div className="auth-separator"><span>lub / або</span></div>
          <div className="auth-oauth-row">
            <button
              type="button"
              className="auth-oauth-btn oauth-google"
              onClick={() => handleOAuth('google')}
              disabled={loading || Boolean(oauthLoading)}
            >
              {oauthLoading === 'google' ? 'Google...' : 'Sign in with Google'}
            </button>
            <button
              type="button"
              className="auth-oauth-btn oauth-facebook"
              onClick={() => handleOAuth('facebook')}
              disabled={loading || Boolean(oauthLoading)}
            >
              {oauthLoading === 'facebook' ? 'Facebook...' : 'Sign in with Facebook'}
            </button>
          </div>
          <div className="auth-privacy-note auth-privacy-desktop" role="note" aria-label="Privacy notice">
            <p className="note-title">Informacja o prywatnosci</p>
            <div className="privacy-line">
              <span className="privacy-label">🍪</span>
              <div className="privacy-text">
                <span className="text-pl">Tylko techniczne pliki cookie do logowania i utrzymania sesji.</span>
              </div>
            </div>
            <div className="privacy-line">
              <span className="privacy-label">🏛️</span>
              <div className="privacy-text">
                <span className="text-pl">FUNDACJA NIEZNISZCZALNA UKRAINA, NIP: PL7812018614.</span>
              </div>
            </div>
            <div className="privacy-line">
              <span className="privacy-label">📍</span>
              <div className="privacy-text">
                <span className="text-pl">ul. Swietego Filipa 25, 31-150 Krakow.</span>
              </div>
            </div>
            <div className="privacy-line">
              <span className="privacy-label">✉️</span>
              <div className="privacy-text">
                <span className="text-pl">Dostep/usuniecie danych:</span>
                <a href="mailto:support@taskwheels.com">support@taskwheels.com</a>
              </div>
            </div>
          </div>

          <details className="auth-privacy-mobile">
            <summary>Informacja o prywatnosci</summary>
            <div className="auth-privacy-note" role="note" aria-label="Privacy notice">
              <div className="privacy-line">
                <span className="privacy-label">🍪</span>
                <div className="privacy-text">
                  <span className="text-pl">Tylko techniczne pliki cookie do logowania i utrzymania sesji.</span>
                </div>
              </div>
              <div className="privacy-line">
                <span className="privacy-label">🏛️</span>
                <div className="privacy-text">
                  <span className="text-pl">FUNDACJA NIEZNISZCZALNA UKRAINA, NIP: PL7812018614.</span>
                </div>
              </div>
              <div className="privacy-line">
                <span className="privacy-label">📍</span>
                <div className="privacy-text">
                  <span className="text-pl">ul. Swietego Filipa 25, 31-150 Krakow.</span>
                </div>
              </div>
              <div className="privacy-line">
                <span className="privacy-label">✉️</span>
                <div className="privacy-text">
                  <span className="text-pl">Dostep/usuniecie danych:</span>
                  <a href="mailto:support@taskwheels.com">support@taskwheels.com</a>
                </div>
              </div>
            </div>
          </details>
        </section>
      </div>
    </div>
  )
}

// =====================================================
// FILE UPLOAD COMPONENT
// =====================================================
function FileUpload({ document, onUpdate, canAdd, canDelete, canView, canComment }) {
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [versionTableReady, setVersionTableReady] = useState(true)
  const [expandedVersionFileId, setExpandedVersionFileId] = useState(null)
  const [expandedCommentFileId, setExpandedCommentFileId] = useState(null)
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

    if (isAuditorSide(profile?.side)) {
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

          if (normalizeSide(profile.side) === SIDE_FNU && fileData) {
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
    try {
      const fileRecord = files.find(f => f.id === fileId)
      if (fileRecord && versionTableReady) {
        try {
          await snapshotCurrentVersion(fileRecord, 'before_delete')
        } catch (err) {
          addToast(`Błąd wersji przed usunięciem: ${sanitizeText(err?.message || 'snapshot_failed')}`, 'warning')
        }
      }

      const { data: resultData, error: invokeError } = await invokeFunctionWithAuthRetry('file-delete', {
        file_id: fileId,
        file_path: filePath,
      })
      if (invokeError || !resultData?.ok) {
        const details = invokeError
          ? await parseFunctionsInvokeError(invokeError)
          : String(resultData?.error || resultData?.message || 'delete_failed')
        throw new Error(details)
      }
      if (resultData?.storage_error) {
        addToast(`Plik usunięty, ale storage cleanup failed: ${sanitizeText(String(resultData.storage_error))}`, 'warning')
      }

      await logAudit(profile.id, 'delete_file', 'document_file', fileId)
      await loadFiles()
      onUpdate?.()
      addToast('Plik usunięty / Файл видалено', 'success')
      if (previewFile?.id === fileId) {
        setPreviewFile(null)
        setPreviewText('')
        if (previewUrl && previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl)
        setPreviewUrl('')
      }
    } catch (err) {
      addToast(`Błąd usuwania: ${sanitizeText(err?.message || 'delete_failed')}`, 'error')
    }
  }

  const handlePreview = async (filePath) => {
    let previewTab = null
    try {
      previewTab = window.open('about:blank', '_blank')
      if (!previewTab) {
        addToast('Popup blocked. Allow popups for this site.', 'warning')
        return
      }
      previewTab.opener = null
      previewTab.document.title = 'Preview...'
      const { data, error } = await supabase.storage.from('documents').createSignedUrl(filePath, 3600)
      if (error || !data?.signedUrl) throw new Error(error?.message || 'signed_url_failed')
      previewTab.location.replace(data.signedUrl)
      await logAudit(profile.id, 'view_file', 'document_file', document.id)
    } catch (err) {
      if (previewTab && !previewTab.closed) previewTab.close()
      addToast(`Błąd podglądu: ${sanitizeText(err?.message || 'preview_failed')}`, 'error')
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
        .in('side', [SIDE_AUDITOR, SIDE_OPERATOR_LEGACY])
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

      addToast('Opublikowano dla AUDITOR / Опубліковано для AUDITOR', 'success')
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
      </div>
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
                  onClick={() => setExpandedCommentFileId(prev => prev === file.id ? null : file.id)}
                  aria-label="Komentarze pliku / Коментарі файлу"
                  title="Komentarze pliku / Коментарі файлу"
                >
                  💬
                </button>
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
                {canDelete && <button onClick={() => handleDelete(file.id, file.file_path)} aria-label="Usuń / Видалити">🗑️</button>}
                {normalizeSide(profile?.side) === SIDE_FNU && profile?.role === 'super_admin' && (
                  <button onClick={() => publishToOperator(file.id)} aria-label="Opublikuj dla AUDITOR" className="btn-publish">📤</button>
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
              {expandedCommentFileId === file.id && (
                <div className="file-comments-panel">
                  <Comments
                    entityType="file"
                    entityId={file.id}
                    parentDocumentId={document.id}
                    canComment={canComment}
                    canView={canView}
                    displayLanguage={resolveLanguageMode('auto', profile?.side)}
                    title="File comments / Коментарі файлу"
                  />
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
const CommentItem = ({ comment, depth, maxDepth, onReply, canComment }) => {
  if (depth >= maxDepth) return null
  const source = comment?.source_language || detectLanguage(comment?.content || '')
  const sourceText = parseMessageContextEnvelope(comment?.content || '').text
  const translatedPl = parseMessageContextEnvelope(comment?.translated_pl || '').text
  const translatedUk = parseMessageContextEnvelope(comment?.translated_uk || '').text
  const renderedPl = translatedPl || (source === 'pl' ? sourceText : sourceText)
  const renderedUk = translatedUk || (source === 'uk' ? sourceText : sourceText)
  const authorKey = comment.author_id || comment.author?.email || comment.author?.full_name || 'unknown'
  const tone = getCommentAuthorTone(authorKey)
  const commentStyle = {
    marginLeft: depth * 16,
    backgroundColor: tone.bg,
    borderLeftColor: tone.border,
  }

  return (
    <div className={`comment ${depth > 0 ? 'reply' : ''}`} style={commentStyle}>
      <div className="comment-header">
        <span className="comment-author">
          <span className="comment-author-name" style={{ color: tone.accent }}>
            <SafeText>{comment.author?.full_name || comment.author?.email}</SafeText>
          </span>
          <span className={`side-badge ${sideClass(comment.author?.side)}`}>{formatSideLabel(comment.author?.side)}</span>
        </span>
        <time dateTime={comment.created_at}>{new Date(comment.created_at).toLocaleString()}</time>
      </div>
      <div className="comment-bilingual">
        <div className="comment-line">
          <span className="comment-lang">PL</span>
          <p className="comment-content compact"><SafeText>{renderedPl}</SafeText></p>
        </div>
        <div className="comment-line">
          <span className="comment-lang">UA</span>
          <p className="comment-content compact"><SafeText>{renderedUk}</SafeText></p>
        </div>
      </div>
      <div className="comment-actions">
        {canComment && depth < maxDepth - 1 && (
          <button onClick={() => onReply(comment.id)} aria-label="Odpowiedz / Відповісти">↩️ Odpowiedz</button>
        )}
      </div>
    </div>
  )
}

// =====================================================
// COMMENTS COMPONENT
// =====================================================
function Comments({ entityType = 'document', entityId, parentDocumentId = null, canComment, canView, displayLanguage, title }) {
  const [comments, setComments] = useState([])
  const [newComment, setNewComment] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [channel, setChannel] = useState('fnu_internal')
  const [useFilePrefixFallback, setUseFilePrefixFallback] = useState(false)
  const addToast = useToast()
  const profile = useProfile()
  const safeSetState = useSafeAsync()
  const MAX_REPLY_DEPTH = 5
  const isLawyerAdmin = profile?.role === 'lawyer_admin' || profile?.role === 'super_admin'
  const isAuditor = normalizeSide(profile?.side) === SIDE_AUDITOR
  const canUseAuditorChannel = isLawyerAdmin || isAuditor
  const entityColumn = entityType === 'section'
    ? 'section_id'
    : entityType === 'file'
      ? 'file_id'
      : 'document_id'
  const fileCommentPrefix = entityType === 'file' && entityId ? `[file:${entityId}] ` : ''
  const stripFilePrefix = (text) => {
    if (typeof text !== 'string' || !fileCommentPrefix) return text
    return text.startsWith(fileCommentPrefix) ? text.slice(fileCommentPrefix.length) : text
  }

  const loadComments = useCallback(async () => {
    if (!entityId) return
    const selectCols = 'id, author_id, content, source_language, translated_pl, translated_uk, translation_provider, created_at, parent_comment_id, visible_to_sides, comment_scope, author:author_id(full_name, email, side)'
    let data = []
    let error = null

    const primaryQuery = await supabase
      .from('comments')
      .select(selectCols)
      .eq(entityColumn, entityId)
      .order('created_at')
    data = primaryQuery.data || []
    error = primaryQuery.error

    if (error && entityType === 'file' && parentDocumentId) {
      const details = `${String(error.message || '')} ${String(error.details || '')} ${String(error.hint || '')}`.toLowerCase()
      const canUseFallback = /file_id|schema cache|column/i.test(details)
      if (canUseFallback) {
        const fallback = await supabase
          .from('comments')
          .select(selectCols)
          .eq('document_id', parentDocumentId)
          .ilike('content', `[file:${entityId}]%`)
          .order('created_at')
        data = (fallback.data || []).map(c => ({
          ...c,
          content: stripFilePrefix(c.content),
          translated_pl: stripFilePrefix(c.translated_pl),
          translated_uk: stripFilePrefix(c.translated_uk),
        }))
        error = fallback.error
        setUseFilePrefixFallback(!fallback.error)
      }
    } else if (entityType === 'file') {
      setUseFilePrefixFallback(false)
    }

    if (error) {
      addToast(`Comments load error: ${sanitizeText(error.message || error.details || 'query_failed')}`, 'error')
      return
    }

    const filtered = (data || []).filter(c => {
      if (profile?.role === 'super_admin') return true
      if ((c.comment_scope || 'fnu_internal') === 'auditor_channel') return canUseAuditorChannel
      return normalizeSide(profile?.side) === SIDE_FNU
    })
    safeSetState(setComments)(filtered)
  }, [entityId, entityColumn, entityType, parentDocumentId, profile, safeSetState, canUseAuditorChannel, addToast, fileCommentPrefix])

  useEffect(() => { if (canView) loadComments() }, [canView, loadComments])
  useEffect(() => {
    if (isAuditor) setChannel('auditor_channel')
  }, [isAuditor])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!newComment.trim() || newComment.length > MAX_COMMENT_LENGTH) return
    setSubmitting(true)
    const cleanContent = sanitizeText(newComment.trim())
    const sourceLanguage = detectLanguage(cleanContent)
    let translatedPl = cleanContent
    let translatedUk = cleanContent
    try {
      ;[translatedPl, translatedUk] = await Promise.all([
        sourceLanguage === 'pl' ? Promise.resolve(cleanContent) : llmTranslateStrict(cleanContent, sourceLanguage, 'pl'),
        sourceLanguage === 'uk' ? Promise.resolve(cleanContent) : llmTranslateStrict(cleanContent, sourceLanguage, 'uk')
      ])
    } catch (translationError) {
      addToast(`Translation failed: ${sanitizeText(String(translationError?.message || 'llm_unavailable'))}`, 'error')
      setSubmitting(false)
      return
    }
    const replyTarget = comments.find(c => c.id === replyTo)
    const scope = replyTarget?.comment_scope || channel
    if (scope === 'auditor_channel' && !canUseAuditorChannel) {
      addToast('Auditor Q&A is available only for lawyer_admin and auditor.', 'error')
      setSubmitting(false)
      return
    }
    if (scope === 'fnu_internal' && normalizeSide(profile?.side) !== SIDE_FNU) {
      addToast('Internal comments are available only for FNU users.', 'error')
      setSubmitting(false)
      return
    }

    const payload = {
      author_id: profile.id,
      content: cleanContent,
      source_language: sourceLanguage,
      translated_pl: translatedPl,
      translated_uk: translatedUk,
      translation_provider: 'smart-api',
      parent_comment_id: replyTo,
      comment_scope: scope,
      visible_to_sides: scope === 'auditor_channel' ? [SIDE_AUDITOR] : [SIDE_FNU]
    }
    if (entityType === 'file' && useFilePrefixFallback) {
      if (!parentDocumentId) {
        addToast('File comments fallback requires document context.', 'error')
        setSubmitting(false)
        return
      }
      payload.document_id = parentDocumentId
      payload.content = `${fileCommentPrefix}${cleanContent}`
    } else {
      if (entityType === 'file' && parentDocumentId) payload.document_id = parentDocumentId
      payload[entityColumn] = entityId
    }

    const { data, error } = await supabase.from('comments').insert(payload).select().single()

    if (!error && data) {
      await logAudit(profile.id, 'add_comment', 'comment', data.id)
      setNewComment('')
      setReplyTo(null)
      loadComments()
      addToast('Komentarz dodany / Коментар додано', 'success')
    }
    setSubmitting(false)
  }

  if (!canView) return null

  const visibleByChannel = comments.filter(c => (c.comment_scope || 'fnu_internal') === channel)
  const topLevel = visibleByChannel.filter(c => !c.parent_comment_id)
  const getReplies = (parentId) => comments.filter(c => c.parent_comment_id === parentId)

  const renderCommentTree = (comment, depth = 0) => (
    <div key={comment.id}>
      <CommentItem
        comment={comment}
        depth={depth}
        maxDepth={MAX_REPLY_DEPTH}
        onReply={setReplyTo}
        canComment={canComment}
      />
      {getReplies(comment.id).map(r => renderCommentTree(r, depth + 1))}
    </div>
  )

  return (
    <section className="comments-section" aria-label="Komentarze / Коментарі">
      <h4><BiText pl={`${title || 'Komentarze'} (${visibleByChannel.length})`} uk={`${title || 'Коментарі'} (${visibleByChannel.length})`} /></h4>

      <div className="comment-channel-switch">
        <button
          type="button"
          className={channel === 'fnu_internal' ? 'active' : ''}
          onClick={() => setChannel('fnu_internal')}
          disabled={isAuditor}
        >
          FNU Internal
        </button>
        {canUseAuditorChannel && (
          <button
            type="button"
            className={channel === 'auditor_channel' ? 'active' : ''}
            onClick={() => setChannel('auditor_channel')}
          >
            Auditor Q&A
          </button>
        )}
      </div>

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
        {visibleByChannel.length === 0 && <div className="no-comments"><BiText pl="Brak komentarzy" uk="Немає коментарів" /></div>}
      </div>
    </section>
  )
}

function SectionCommentsModal({ section, onClose, displayLanguage, canComment }) {
  const modalRef = useRef(null)
  useFocusTrap(modalRef, true)
  if (!section) return null

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal document-detail" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2>
            <span>{section.code}.</span> <SafeText>{section.name_pl}</SafeText>
          </h2>
          <button className="close-btn" onClick={onClose} aria-label="Zamknij">✕</button>
        </div>
        <Comments
          entityType="section"
          entityId={section.id}
          canComment={canComment}
          canView={true}
          displayLanguage={displayLanguage}
          title="Folder comments / Коментарі папки"
        />
      </div>
    </div>
  )
}

function TaskBoard({ companyId, sectionId }) {
  const profile = useProfile()
  const addToast = useToast()
  const [tasks, setTasks] = useState([])
  const [taskMembers, setTaskMembers] = useState({})
  const [lastMessages, setLastMessages] = useState({})
  const [users, setUsers] = useState([])
  const [selectedTaskId, setSelectedTaskId] = useState(null)
  const [newTask, setNewTask] = useState({ topic: '', note: '' })
  const [newComment, setNewComment] = useState('')
  const [recipientMode, setRecipientMode] = useState('direct')
  const [selectedDirectUserId, setSelectedDirectUserId] = useState('')
  const [selectedRecipients, setSelectedRecipients] = useState([])
  const isFnu = normalizeSide(profile?.side) === SIDE_FNU
  const formatUserLabel = useCallback((user) => {
    const roleLabel = ROLES[user?.role]?.uk || ROLES[user?.role]?.pl || user?.role || 'Користувач'
    const rawName = (user?.full_name || '').trim()
    const looksLikeEmail = /@/.test(rawName)
    const nameLabel = rawName && !looksLikeEmail ? rawName : 'Невказане імʼя'
    return `${roleLabel} · ${nameLabel}`
  }, [])

  const loadUsers = useCallback(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, email, side, role')
      .eq('is_active', true)
      .eq('side', SIDE_FNU)
      .neq('role', 'super_admin')
      .neq('id', profile?.id || '')
      .order('full_name')
    if (!error) setUsers(data || [])
  }, [profile?.id])

  const loadTasks = useCallback(async () => {
    if (!profile?.id || !companyId || !sectionId) return
    const { data, error } = await supabase
      .from('chat_thread_members')
      .select(`
        thread_id,
        thread:thread_id (
          id, topic, updated_at, created_at, is_archived, company_id, section_id
        )
      `)
      .eq('user_id', profile.id)
      .eq('is_active', true)
    if (error) return
    const taskThreads = (data || [])
      .map(r => r.thread)
      .filter(Boolean)
      .filter(t => t.company_id === companyId && t.section_id === sectionId && (t.topic || '').startsWith('[TASK] '))
      .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))
    setTasks(taskThreads)
    if (!selectedTaskId && taskThreads.length > 0) setSelectedTaskId(taskThreads[0].id)

    const ids = taskThreads.map(t => t.id)
    if (ids.length === 0) return
    const [{ data: members }, { data: msgs }] = await Promise.all([
      supabase.from('chat_thread_members').select('thread_id, user_id, user:user_id(id, full_name, email, side)').in('thread_id', ids).eq('is_active', true),
      supabase.from('chat_messages').select('thread_id, content, created_at, sender:sender_id(full_name, email)').in('thread_id', ids).order('created_at', { ascending: false })
    ])
    const groupedMembers = (members || []).reduce((acc, item) => {
      if (!acc[item.thread_id]) acc[item.thread_id] = []
      acc[item.thread_id].push(item)
      return acc
    }, {})
    setTaskMembers(groupedMembers)
    const lastByThread = {}
    for (const m of msgs || []) {
      if (!lastByThread[m.thread_id]) lastByThread[m.thread_id] = m
    }
    setLastMessages(lastByThread)
  }, [profile?.id, companyId, sectionId, selectedTaskId])

  useEffect(() => { if (isFnu) loadUsers() }, [isFnu, loadUsers])
  useEffect(() => { if (isFnu) loadTasks() }, [isFnu, loadTasks])
  useEffect(() => {
    if (recipientMode === 'direct') setSelectedRecipients(selectedDirectUserId ? [selectedDirectUserId] : [])
  }, [recipientMode, selectedDirectUserId])

  const toggleRecipient = (id) => {
    setSelectedRecipients(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  const createTask = async (e) => {
    e.preventDefault()
    const recipients = (recipientMode === 'group' ? selectedRecipients : [selectedDirectUserId]).filter(isValidUUID)
    if (!newTask.topic.trim() || recipients.length === 0 || !companyId || !sectionId) return
    const { data: thread, error: threadError } = await supabase
      .from('chat_threads')
      .insert({
        topic: `[TASK] ${sanitizeText(newTask.topic.trim())}`,
        company_id: companyId,
        section_id: sectionId,
        created_by: profile.id,
        is_archived: false
      })
      .select()
      .single()
    if (threadError || !thread?.id) {
      addToast('Task create failed', 'error')
      return
    }
    const members = [profile.id, ...Array.from(new Set(recipients))].map((userId) => ({
      thread_id: thread.id,
      user_id: userId,
      member_role: userId === profile.id ? 'owner' : 'member',
      is_active: true
    }))
    await supabase.from('chat_thread_members').insert(members)
    if (newTask.note.trim()) {
      await supabase.from('chat_messages').insert({
        thread_id: thread.id,
        sender_id: profile.id,
        content: sanitizeText(newTask.note.trim()),
        source_language: detectLanguage(newTask.note.trim())
      })
    }
    setNewTask({ topic: '', note: '' })
    setSelectedDirectUserId('')
    setSelectedRecipients([])
    setRecipientMode('direct')
    await loadTasks()
    setSelectedTaskId(thread.id)
    addToast('Task published', 'success')
  }

  const markDone = async (taskId, done) => {
    await supabase.from('chat_threads').update({ is_archived: done }).eq('id', taskId)
    await loadTasks()
  }

  const addTaskComment = async (e) => {
    e.preventDefault()
    if (!selectedTaskId || !newComment.trim()) return
    const text = sanitizeText(newComment.trim())
    await supabase.from('chat_messages').insert({
      thread_id: selectedTaskId,
      sender_id: profile.id,
      content: text,
      source_language: detectLanguage(text)
    })
    setNewComment('')
    await loadTasks()
  }

  if (!isFnu) return null

  return (
    <section className="task-board" aria-label="FNU Task Board">
      <h3><BiText pl="Tablica zadań FNU" uk="Дошка завдань FNU" /></h3>
      <form className="task-create-form" onSubmit={createTask}>
        <input
          value={newTask.topic}
          onChange={e => setNewTask(prev => ({ ...prev, topic: e.target.value }))}
          placeholder="Temat zadania / питання"
          maxLength={120}
          required
        />
        <textarea
          value={newTask.note}
          onChange={e => setNewTask(prev => ({ ...prev, note: e.target.value }))}
          placeholder="Opis (opcjonalnie) / Опис (необов'язково)"
          rows={2}
        />
        <div className="task-recipient-row">
          <select value={recipientMode} onChange={e => setRecipientMode(e.target.value)}>
            <option value="direct">Direct / Прямо</option>
            <option value="group">Group / Група</option>
          </select>
          {recipientMode === 'direct' ? (
            <select value={selectedDirectUserId} onChange={e => setSelectedDirectUserId(e.target.value)}>
              <option value="" disabled hidden>Wybierz użytkownika / Виберіть користувача</option>
              {users.map(u => <option key={u.id} value={u.id}>{formatUserLabel(u)}</option>)}
            </select>
          ) : (
            <div className="task-group-list">
              {users.map(u => (
                <label key={u.id}>
                  <input type="checkbox" checked={selectedRecipients.includes(u.id)} onChange={() => toggleRecipient(u.id)} />
                  <span><SafeText>{formatUserLabel(u)}</SafeText></span>
                </label>
              ))}
            </div>
          )}
          <button type="submit"><BiText pl="Opublikuj" uk="Опублікувати" /></button>
        </div>
      </form>

      <div className="task-list">
        {tasks.map(task => {
          const members = taskMembers[task.id] || []
          const last = lastMessages[task.id]
          const isDone = !!task.is_archived
          return (
            <article key={task.id} className={`task-card ${selectedTaskId === task.id ? 'active' : ''}`} onClick={() => setSelectedTaskId(task.id)}>
              <header>
                <strong><SafeText>{(task.topic || '').replace('[TASK] ', '')}</SafeText></strong>
                <span className={`task-status ${isDone ? 'done' : 'open'}`}>
                  {isDone ? 'Done / Виконано' : 'Open / Відкрите'}
                </span>
              </header>
              <p className="task-meta">{members.length} users / користувачів</p>
              {last && (
                <p className="task-last">
                  <SafeText>{last.sender?.full_name || 'Користувач'}:</SafeText> <SafeText>{String(last.content || '').slice(0, 70)}</SafeText>
                </p>
              )}
              <div className="task-actions">
                <button type="button" onClick={(e) => { e.stopPropagation(); markDone(task.id, !isDone) }}>
                  {isDone ? 'Reopen / Відкрити знову' : 'Mark done / Виконано'}
                </button>
              </div>
            </article>
          )
        })}
        {tasks.length === 0 && <div className="no-comments">Brak zadań w tej sekcji / Немає завдань у цій секції.</div>}
      </div>

      {selectedTaskId && (
        <form className="task-comment-form" onSubmit={addTaskComment}>
          <input value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Dodaj komentarz / pytanie... / Додайте коментар / питання..." />
          <button type="submit"><BiText pl="Komentarz" uk="Коментар" /></button>
        </form>
      )}
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
                  <span className={`side-badge ${sideClass(u.side)}`}>{formatSideLabel(u.side)}</span>
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
                        <span className={`side-badge ${sideClass(m.sender?.side)}`}>{formatSideLabel(m.sender?.side)}</span>
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
  const [invites, setInvites] = useState([])
  const [loading, setLoading] = useState(true)
  const [loadingInvites, setLoadingInvites] = useState(false)
  const [newUser, setNewUser] = useState({ email: '', password: '', full_name: '', phone: '', position: '', company_name: '', role: 'user_fnu', side: 'FNU' })
  const [inviteForm, setInviteForm] = useState({ email: '', role: 'user_fnu', side: SIDE_FNU, expires_hours: 24 })
  const [creating, setCreating] = useState(false)
  const [sendingInvite, setSendingInvite] = useState(false)
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

  const loadInvites = useCallback(async () => {
    safeSetState(setLoadingInvites)(true)
    const { data, error } = await supabase.functions.invoke('invite-user', {
      body: { action: 'list' }
    })
    if (error || !data?.ok) {
      addToast(`Błąd invite list: ${sanitizeText(error?.message || data?.error || 'invite_list_failed')}`, 'error')
      safeSetState(setLoadingInvites)(false)
      return
    }
    safeSetState(setInvites)(Array.isArray(data.invites) ? data.invites : [])
    safeSetState(setLoadingInvites)(false)
  }, [addToast, safeSetState])

  useEffect(() => {
    loadInvites()
  }, [loadInvites])

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
        const requestedSide = normalizeSide(newUser.side)
        const upsertResult = await supabase.from('profiles').upsert({
          id: data.user.id,
          email: newUser.email,
          full_name: sanitizeText(newUser.full_name),
          phone: sanitizeText(newUser.phone),
          position: sanitizeText(newUser.position),
          company_name: sanitizeText(newUser.company_name),
          role: newUser.role,
          side: requestedSide,
          is_active: true
        })
        // If DB still expects legacy side value, retry once.
        if (upsertResult.error && requestedSide === SIDE_AUDITOR) {
          await supabase.from('profiles').upsert({
            id: data.user.id,
            email: newUser.email,
            full_name: sanitizeText(newUser.full_name),
            phone: sanitizeText(newUser.phone),
            position: sanitizeText(newUser.position),
            company_name: sanitizeText(newUser.company_name),
            role: newUser.role,
            side: SIDE_OPERATOR_LEGACY,
            is_active: true
          })
        }
        await logAudit(profile.id, 'create_user', 'profile', data.user.id)
      }

      setNewUser({ email: '', password: '', full_name: '', phone: '', position: '', company_name: '', role: 'user_fnu', side: SIDE_FNU })

      const { data: usersData } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
      safeSetState(setUsers)(usersData || [])

      addToast('Użytkownik utworzony / Користувача створено', 'success')
    } catch (err) { addToast('Błąd: ' + err.message, 'error') }
    setCreating(false)
  }

  const updateUser = async (userId, updates) => {
    const next = { ...updates }
    if (next.side) next.side = normalizeSide(next.side)

    let { error } = await supabase.from('profiles').update(next).eq('id', userId)
    // Backward-compat for legacy DB values.
    if (error && next.side === SIDE_AUDITOR) {
      const retry = await supabase.from('profiles').update({ ...next, side: SIDE_OPERATOR_LEGACY }).eq('id', userId)
      error = retry.error
    }
    if (error) {
      addToast('Błąd: ' + sanitizeText(error.message || 'update_failed'), 'error')
      return
    }

    await logAudit(profile.id, 'update_user', 'profile', userId, next)

    const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
    safeSetState(setUsers)(data || [])

    addToast('Zaktualizowano / Оновлено', 'success')
  }

  const sendInvite = async (e) => {
    e.preventDefault()
    if (!inviteForm.email.trim()) return
    setSendingInvite(true)
    try {
      const payload = {
        action: 'send',
        email: inviteForm.email.trim().toLowerCase(),
        role: inviteForm.role,
        side: normalizeSide(inviteForm.side),
        expires_hours: Number(inviteForm.expires_hours || 24)
      }
      const { data, error } = await supabase.functions.invoke('invite-user', { body: payload })
      if (error || !data?.ok) throw new Error(error?.message || data?.error || 'invite_send_failed')
      setInviteForm({ email: '', role: 'user_fnu', side: SIDE_FNU, expires_hours: 24 })
      addToast('Zaproszenie wysłane / Запрошення надіслано', 'success')
      await loadInvites()
    } catch (err) {
      addToast(`Błąd invite: ${sanitizeText(err?.message || 'invite_send_failed')}`, 'error')
    } finally {
      setSendingInvite(false)
    }
  }

  const resendInvite = async (inviteId) => {
    if (!inviteId) return
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', {
        body: { action: 'resend', invite_id: inviteId }
      })
      if (error || !data?.ok) throw new Error(error?.message || data?.error || 'invite_resend_failed')
      addToast('Zaproszenie wysłane ponownie / Запрошення відправлено повторно', 'success')
      await loadInvites()
    } catch (err) {
      addToast(`Błąd resend: ${sanitizeText(err?.message || 'invite_resend_failed')}`, 'error')
    }
  }

  const revokeInvite = async (inviteId) => {
    if (!inviteId) return
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', {
        body: { action: 'revoke', invite_id: inviteId }
      })
      if (error || !data?.ok) throw new Error(error?.message || data?.error || 'invite_revoke_failed')
      addToast('Zaproszenie cofnięte / Запрошення відкликано', 'warning')
      await loadInvites()
    } catch (err) {
      addToast(`Błąd revoke: ${sanitizeText(err?.message || 'invite_revoke_failed')}`, 'error')
    }
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
            <h4><BiText pl="Invite-only onboarding (email link)" uk="Запрошення через email-посилання" /></h4>
            <form onSubmit={sendInvite} className="user-form">
              <div className="form-grid">
                <input
                  placeholder="Email zaproszenia / Email запрошення"
                  type="email"
                  value={inviteForm.email}
                  onChange={e => setInviteForm({ ...inviteForm, email: e.target.value })}
                  required
                  aria-label="Email zaproszenia"
                />
                <select value={inviteForm.side} onChange={e => setInviteForm({ ...inviteForm, side: e.target.value })} aria-label="Strona invite">
                  {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                </select>
                <select value={inviteForm.role} onChange={e => setInviteForm({ ...inviteForm, role: e.target.value })} aria-label="Rola invite">
                  {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                </select>
                <input
                  type="number"
                  min="1"
                  max="168"
                  value={inviteForm.expires_hours}
                  onChange={e => setInviteForm({ ...inviteForm, expires_hours: Number(e.target.value || 24) })}
                  aria-label="Wygasa za godzin"
                  placeholder="Expires hours"
                />
              </div>
              <button type="submit" className="btn-primary" disabled={sendingInvite}>
                {sendingInvite ? '...' : 'Wyślij invite / Надіслати invite'}
              </button>
            </form>
            <div className="users-table-container" style={{ marginTop: 12 }}>
              <h4><BiText pl={`Zaproszenia (${invites.length})`} uk={`Запрошення (${invites.length})`} /></h4>
              {loadingInvites ? <div className="loading">...</div> : (
                <table className="users-table" aria-label="Lista zaproszeń">
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Rola</th>
                      <th scope="col">Strona</th>
                      <th scope="col">Status</th>
                      <th scope="col">Wygasa</th>
                      <th scope="col">Akcje</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map(inv => (
                      <tr key={inv.id}>
                        <td>{inv.email}</td>
                        <td>{ROLES[inv.role]?.pl || inv.role}</td>
                        <td>{formatSideLabel(inv.side)}</td>
                        <td>{inv.invite_status}</td>
                        <td>{inv.expires_at ? new Date(inv.expires_at).toLocaleString() : '—'}</td>
                        <td>
                          <button onClick={() => resendInvite(inv.id)} className="btn-success" disabled={inv.invite_status === 'revoked'} aria-label="Resend invite">
                            ↻
                          </button>
                          <button onClick={() => revokeInvite(inv.id)} className="btn-danger" disabled={inv.invite_status === 'revoked'} aria-label="Revoke invite">
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!invites.length && (
                      <tr>
                        <td colSpan="6">Brak zaproszeń / Немає запрошень</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
          </div>

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
                      <select
                        value={normalizeSide(u.side) || SIDE_FNU}
                        onChange={e => updateUser(u.id, { side: e.target.value })}
                        className={`side-select ${sideClass(u.side)}`}
                        aria-label={`Strona dla ${u.email}`}
                      >
                        {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
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
    'update_user': '✏️ Aktualizacja użytkownika',
    'invite_send': '✉️ Wysłanie zaproszenia',
    'invite_resend': '🔁 Ponowne wysłanie zaproszenia',
    'invite_revoke': '⛔ Cofnięcie zaproszenia'
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
                      {log.user?.side && <span className={`side-badge ${sideClass(log.user.side)}`}>{formatSideLabel(log.user.side)}</span>}
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
function DocumentDetail({ document, onClose, onUpdate, displayLanguage, permissions }) {
  const [doc, setDoc] = useState(document)
  const [users, setUsers] = useState([])
  const modalRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()
  const safeSetState = useSafeAsync()

  const isSuperAdmin = profile?.role === 'super_admin'
  const isAdmin = isSuperAdmin || profile?.role === 'lawyer_admin'
  const canAdd = isAdmin || Boolean(permissions?.can_upload)
  const canDelete = isAdmin || Boolean(permissions?.can_manage)
  const canComment = isAdmin || Boolean(permissions?.can_comment)
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
            <FileUpload document={doc} onUpdate={onUpdate} canAdd={canAdd} canDelete={canDelete} canView={canView} canComment={canComment} />
          </ErrorBoundary>
          <ErrorBoundary>
            <Comments
              entityType="document"
              entityId={doc.id}
              canComment={canComment}
              canView={canView}
              displayLanguage={displayLanguage}
              title="Document comments / Коментарі документа"
            />
          </ErrorBoundary>
        </div>
      </div>
    </div>
  )
}

// =====================================================
// SECTION MANAGER
// =====================================================
function SectionManager({ company, sections, onUpdate, onClose, canManageMain }) {
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
    if (!canManageMain && !parentSectionId) {
      addToast('Only admin can create root folders. Choose parent folder.', 'warning')
      return
    }
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
    const section = (allSections.length ? allSections : sections).find((s) => s.id === sectionId)
    if (!canManageMain && !section?.parent_section_id) {
      addToast('Only admin can delete root folders.', 'error')
      return
    }
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
              <option value="">{canManageMain ? 'Folder główny / Головна папка' : 'Wymagana папка nadrzędna / Потрібна батьківська папка'}</option>
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

function InlineDocumentDrawer({ document, onUpdate, displayLanguage, permissions }) {
  const profile = useProfile()
  const isSuperAdmin = profile?.role === 'super_admin'
  const isAdmin = isSuperAdmin || profile?.role === 'lawyer_admin'
  const canAdd = isAdmin || Boolean(permissions?.can_upload)
  const canDelete = isAdmin || Boolean(permissions?.can_manage)
  const canComment = isAdmin || Boolean(permissions?.can_comment)
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
          <FileUpload document={document} onUpdate={onUpdate} canAdd={canAdd} canDelete={canDelete} canView={canView} canComment={canComment} />
        </ErrorBoundary>
        <ErrorBoundary>
          <Comments
            entityType="document"
            entityId={document.id}
            canComment={canComment}
            canView={canView}
            displayLanguage={displayLanguage}
            title="Document comments / Коментарі документа"
          />
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
  const [authError, setAuthError] = useState('')
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
  const [showSectionComments, setShowSectionComments] = useState(false)
  const [docSearch, setDocSearch] = useState('')
  const [docStatusFilter, setDocStatusFilter] = useState('all')
  const [docFileStats, setDocFileStats] = useState({})
  const [folderAclRows, setFolderAclRows] = useState([])
  const [auditAppId, setAuditAppId] = useState('')
  const [sectionToolsBusy, setSectionToolsBusy] = useState(false)
  const [localUploadDocId, setLocalUploadDocId] = useState('')
  const [localUploadBusyDocId, setLocalUploadBusyDocId] = useState('')
  const localUploadInputRef = useRef(null)
  const [newDocument, setNewDocument] = useState({ code: '', name_pl: '', name_uk: '' })
  const [creatingDocument, setCreatingDocument] = useState(false)
  const addToast = useToast()
  const safeSetState = useSafeAsync()
  const isSuperAdmin = profile?.role === 'super_admin'
  const isAdmin = isSuperAdmin || profile?.role === 'lawyer_admin'
  const aclBySection = useMemo(() => {
    const map = new Map()
    for (const row of folderAclRows || []) {
      if (row?.section_id) map.set(row.section_id, row)
    }
    return map
  }, [folderAclRows])
  const aclEnabledForUser = !isAdmin && normalizeSide(profile?.side) === SIDE_FNU && folderAclRows.length > 0
  const currentSectionAcl = activeSection?.id ? aclBySection.get(activeSection.id) : null
  const canViewCurrentSection = isAdmin || !aclEnabledForUser || Boolean(currentSectionAcl?.can_view)
  const canCommentCurrentSection = isAdmin || !aclEnabledForUser || Boolean(currentSectionAcl?.can_comment)
  const canUploadCurrentSection = isAdmin || !aclEnabledForUser || Boolean(currentSectionAcl?.can_upload)
  const canManageCurrentSection = isAdmin || !aclEnabledForUser || Boolean(currentSectionAcl?.can_manage)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session) {
        supabase.functions.invoke('invite-user', { body: { action: 'accept' } }).catch(() => {})
        loadProfile(data.session.user.id)
      }
      else setLoading(false)
    })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setSession(session)
      if (session) {
        supabase.functions.invoke('invite-user', { body: { action: 'accept' } }).catch(() => {})
        loadProfile(session.user.id)
      }
      else { setProfile(null); setLoading(false) }
    })
    return () => subscription?.unsubscribe()
  }, [])

  const loadProfile = async (userId) => {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single()
    if (error || !data) {
      safeSetState(setProfile)(null)
      safeSetState(setAuthError)('Access denied: your account is not provisioned in profiles.')
      safeSetState(setLoading)(false)
      return
    }
    safeSetState(setAuthError)('')
    safeSetState(setProfile)(data)
    loadCompanies()
  }

  const loadCompanies = async () => {
    const { data } = await supabase.from('companies').select('*').order('order_index')
    safeSetState(setCompanies)(data || [])
    if (data?.length > 0) safeSetState(setSelectedCompany)(data[0])
    safeSetState(setLoading)(false)
  }

  const loadAuditAppId = useCallback(async () => {
    const { data } = await supabase.from('tw_apps').select('id,slug').eq('slug', 'audit').limit(1)
    const row = Array.isArray(data) ? data[0] : null
    setAuditAppId(row?.id || '')
  }, [])

  const loadFolderAcl = useCallback(async () => {
    if (!profile?.id || !auditAppId) {
      setFolderAclRows([])
      return
    }
    if (profile.role === 'super_admin' || profile.role === 'lawyer_admin') {
      setFolderAclRows([])
      return
    }
    const { data } = await supabase
      .from('tw_folder_acl')
      .select('id,section_id,can_view,can_comment,can_upload,can_manage')
      .eq('user_id', profile.id)
      .eq('app_id', auditAppId)
    setFolderAclRows(Array.isArray(data) ? data : [])
  }, [profile?.id, profile?.role, auditAppId])

  const loadSections = useCallback(async () => {
    if (!selectedCompany) return
    const { data } = await supabase.from('document_sections').select('*').eq('company_id', selectedCompany.id).is('parent_section_id', null).order('order_index')
    const all = data || []
    const visible = aclEnabledForUser
      ? all.filter((s) => Boolean(aclBySection.get(s.id)?.can_view))
      : all
    safeSetState(setSections)(visible)
    if (visible?.length > 0 && !activeSection) safeSetState(setActiveSection)(visible[0])
  }, [selectedCompany, activeSection, safeSetState, aclEnabledForUser, aclBySection])

  useEffect(() => { if (selectedCompany) loadSections() }, [selectedCompany, loadSections])
  useEffect(() => { loadAuditAppId() }, [loadAuditAppId])
  useEffect(() => { loadFolderAcl() }, [loadFolderAcl])
  useEffect(() => {
    if (!activeSection?.id) return
    if (!sections.some((s) => s.id === activeSection.id)) {
      setActiveSection(sections[0] || null)
    }
  }, [sections, activeSection?.id])

  const loadDocuments = useCallback(async () => {
    if (!activeSection) return
    const enforceAcl = profile?.role !== 'super_admin' && profile?.role !== 'lawyer_admin' && normalizeSide(profile?.side) === SIDE_FNU && folderAclRows.length > 0
    if (enforceAcl) {
      const acl = folderAclRows.find((r) => r.section_id === activeSection.id)
      if (!acl?.can_view) {
        safeSetState(setDocuments)([])
        safeSetState(setDocFileStats)({})
        return
      }
    }
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
  }, [activeSection, safeSetState, folderAclRows, profile?.role, profile?.side])

  useEffect(() => { if (activeSection) loadDocuments() }, [activeSection, loadDocuments])

  const updateStatus = async (docId, status) => {
    if (!isValidUUID(docId)) return
    await supabase.from('documents').update({ status, updated_at: new Date().toISOString() }).eq('id', docId)
    await logAudit(profile.id, 'update_status', 'document', docId, { status })
    loadDocuments()
  }

  const createDocument = async (e) => {
    e.preventDefault()
    if (!activeSection?.id || !canManageCurrentSection) return
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
  if (authError) {
    return (
      <div className="loading" role="alert">
        <p>{authError}</p>
        <button onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    )
  }
  if (!profile) return <div className="loading" role="status" aria-live="polite">Ładowanie profilu... / Завантаження профілю...</div>

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

  const toggleDocumentDrawer = (docId) => {
    setExpandedDocId(prev => (prev === docId ? null : docId))
  }

  const downloadSectionArchive = async () => {
    if (!activeSection?.id) return
    setSectionToolsBusy(true)
    try {
      const { data: subSections } = await supabase.from('document_sections').select('id,code,name_pl').eq('parent_section_id', activeSection.id)
      const sectionIds = [activeSection.id, ...(subSections || []).map((s) => s.id)]
      const { data: docs } = await supabase
        .from('documents')
        .select('id,code,name_pl,section_id')
        .in('section_id', sectionIds)
        .order('order_index')
      const docIds = (docs || []).map((d) => d.id)
      if (!docIds.length) {
        addToast('No documents to export in this section.', 'warning')
        setSectionToolsBusy(false)
        return
      }
      const { data: files } = await supabase
        .from('document_files')
        .select('id,document_id,file_name,file_path')
        .in('document_id', docIds)
      if (!files?.length) {
        addToast('No files to export in this section.', 'warning')
        setSectionToolsBusy(false)
        return
      }

      const sectionMap = new Map([[activeSection.id, `${activeSection.code} ${activeSection.name_pl}`], ...((subSections || []).map((s) => [s.id, `${s.code} ${s.name_pl}`]))])
      const docMap = new Map((docs || []).map((d) => [d.id, d]))
      const zip = new JSZip()
      for (const file of files) {
        const doc = docMap.get(file.document_id)
        if (!doc) continue
        const { data: blob, error } = await supabase.storage.from('documents').download(file.file_path)
        if (error || !blob) continue
        const folderName = sectionMap.get(doc.section_id) || 'Section'
        const docFolder = `${folderName}/${doc.code || 'DOC'} ${doc.name_pl || 'Document'}`
        zip.folder(docFolder)?.file(file.file_name || 'file.bin', blob)
      }
      const zipped = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(zipped)
      const a = window.document.createElement('a')
      a.href = url
      a.download = `${activeSection.code || 'section'}-archive.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 15000)
      addToast('Section archive prepared.', 'success')
    } catch (e) {
      addToast(`Archive error: ${sanitizeText(e?.message || 'failed')}`, 'error')
    }
    setSectionToolsBusy(false)
  }

  const importGoogleDriveForDocument = async (doc) => {
    if (!doc?.id || !doc?.section_id || !selectedCompany?.id) return
    const sourceUrl = window.prompt('Google Drive file URL or file ID:')
    if (!sourceUrl) return
    if (/\/folders\//i.test(sourceUrl)) {
      addToast('Only file links are supported. Please provide Google Drive file URL/ID.', 'warning')
      return
    }
    const modeInput = window.prompt('Import destination: current | new (new subfolder)', 'current')
    const mode = String(modeInput || '').trim().toLowerCase()
    if (!['current', 'new'].includes(mode)) {
      addToast('Choose destination mode: current or new.', 'warning')
      return
    }
    const createSubfolder = mode === 'new'
    let subfolderName = ''
    if (createSubfolder) {
      subfolderName = window.prompt('Enter new subfolder name:', '') || ''
      if (!subfolderName.trim()) {
        addToast('Subfolder name is required for mode=new.', 'warning')
        return
      }
    }

    setSectionToolsBusy(true)
    try {
      const { data: currentSessionData, error: currentSessionErr } = await supabase.auth.getSession()
      if (currentSessionErr) throw new Error(currentSessionErr.message || 'Failed to read auth session')
      if (!currentSessionData?.session?.access_token) {
        throw new Error('Session not found on this domain. Please sign in again.')
      }

      const { data: userData, error: userErr } = await supabase.auth.getUser()
      if (userErr || !userData?.user?.id) {
        const { data: refreshed, error: refreshErr } = await supabase.auth.refreshSession()
        if (refreshErr || !refreshed?.session?.access_token) {
          throw new Error(`Session expired: ${String(refreshErr?.message || 'refresh_failed')}. Please sign in again.`)
        }
        const { data: userDataAfterRefresh, error: userErrAfterRefresh } = await supabase.auth.getUser()
        if (userErrAfterRefresh || !userDataAfterRefresh?.user?.id) {
          throw new Error(`Session is invalid: ${String(userErrAfterRefresh?.message || 'user_not_found_after_refresh')}. Please sign in again.`)
        }
      }

      const payload = {
        import_type: 'file',
        source_url: sourceUrl.trim(),
        file_url: sourceUrl.trim(),
        company_id: selectedCompany.id,
        section_id: doc.section_id,
        target_document_id: createSubfolder ? '' : doc.id,
        create_subfolder: createSubfolder,
        subfolder_name: subfolderName.trim(),
      }

      const { data, error } = await invokeGdriveImportWithAuthRetry(payload)
      if (error || !data?.ok) {
        const details = error
          ? await parseFunctionsInvokeError(error)
          : String(data?.error || data?.message || 'import_failed')
        if (/invalid jwt/i.test(details)) {
          throw new Error(`Session token rejected by API: ${details}`)
        }
        throw new Error(details)
      }
      const imported = Number(data.imported || 0)
      const scanned = Number(data.scanned || 0)
      const skipped = Number(data.skipped || 0)
      const runId = data?.run_id ? ` | run_id=${String(data.run_id)}` : ''
      if (imported > 0) {
        const destination = createSubfolder ? `new subfolder "${subfolderName.trim()}"` : `document ${doc.code}`
        addToast(`Imported ${imported}/${scanned || imported} file(s) from Google Drive to ${destination}.${runId}`, 'success')
      } else {
        const firstReason = Array.isArray(data.skipped_samples) && data.skipped_samples[0]?.reason ? String(data.skipped_samples[0].reason) : 'no files imported'
        addToast(`Imported 0/${scanned} from Google Drive. Skipped: ${skipped}. Reason: ${firstReason}${runId}`, 'warning')
      }
      await loadSections()
      await loadDocuments()
    } catch (e) {
      const details = String(e?.message || 'failed')
      addToast(`Google Drive import failed: ${sanitizeText(details)}`, 'error')
      if (/session .*sign in again/i.test(details)) {
        setTimeout(() => {
          const loginUrl = new URL(`${window.location.origin}/login`)
          loginUrl.searchParams.set('app', 'audit')
          window.location.href = loginUrl.toString()
        }, 500)
      }
    }
    setSectionToolsBusy(false)
  }

  const uploadLocalFilesForDocument = async (doc, selectedFiles) => {
    if (!doc?.id || !isValidUUID(doc.id) || !profile?.id) return
    const files = Array.isArray(selectedFiles) ? selectedFiles : []
    if (files.length === 0) return

    setLocalUploadBusyDocId(doc.id)
    try {
      const { count, error: countError } = await supabase
        .from('document_files')
        .select('id', { count: 'exact', head: true })
        .eq('document_id', doc.id)

      let existingCount = Number.isFinite(count) ? Number(count) : 0
      if (countError) {
        const { data: fallbackRows, error: fallbackError } = await supabase
          .from('document_files')
          .select('id')
          .eq('document_id', doc.id)
        if (fallbackError) throw fallbackError
        existingCount = Array.isArray(fallbackRows) ? fallbackRows.length : 0
      }

      if (existingCount + files.length > MAX_FILES_PER_DOC) {
        addToast(`Maksymalnie ${MAX_FILES_PER_DOC} plików / Максимум ${MAX_FILES_PER_DOC} файлів`, 'error')
        return
      }

      let successCount = 0
      let failedCount = 0

      for (const file of files) {
        const validation = validateFile(file)
        if (!validation.valid) {
          failedCount++
          addToast(validation.error, 'error')
          continue
        }

        const safeFileName = sanitizeFileName(file.name)
        const filePath = `${doc.id}/${safeFileName}`
        try {
          const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, file)
          if (uploadError) throw uploadError

          const ext = getFileExtension(file.name)
          const { data: fileData, error: dbError } = await supabase.from('document_files').insert({
            document_id: doc.id,
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

          await logAudit(profile.id, 'upload_file', 'document_file', doc.id, { file_name: file.name, source: 'doc_row_upload' })

          if (normalizeSide(profile.side) === SIDE_FNU && fileData) {
            await supabase.from('document_access').insert({
              document_id: doc.id,
              file_id: fileData.id,
              visible_to_operator: false
            })
          }
          successCount++
        } catch (err) {
          failedCount++
          addToast(`Błąd: ${file.name} (${sanitizeText(err?.message || 'upload_failed')})`, 'error')
        }
      }

      if (successCount > 0 && failedCount === 0) {
        addToast(`Pliki przesłane (${successCount}) / Файли завантажено (${successCount})`, 'success')
      } else if (successCount > 0 && failedCount > 0) {
        addToast(`Częściowo: ${successCount} OK, ${failedCount} błędów / Частково: ${successCount} OK, ${failedCount} помилок`, 'warning')
      } else if (failedCount > 0) {
        addToast('Wysyłka nieudana / Завантаження не вдалося', 'error')
      }

      await loadSections()
      await loadDocuments()
    } catch (err) {
      addToast(`Upload failed: ${sanitizeText(err?.message || 'failed')}`, 'error')
    } finally {
      setLocalUploadBusyDocId('')
      setLocalUploadDocId('')
    }
  }

  const openLocalUploadForDocument = (doc) => {
    if (!doc?.id || !canUploadCurrentSection || sectionToolsBusy || localUploadBusyDocId) return
    setLocalUploadDocId(doc.id)
    if (localUploadInputRef.current) {
      localUploadInputRef.current.value = ''
      localUploadInputRef.current.click()
    }
  }

  const onLocalUploadInputChange = async (e) => {
    const selectedFiles = Array.from(e.target.files || [])
    const targetDocId = localUploadDocId
    e.target.value = ''
    if (!targetDocId || selectedFiles.length === 0) {
      setLocalUploadDocId('')
      return
    }
    const targetDoc = documents.find(d => d.id === targetDocId)
    if (!targetDoc) {
      addToast('Document not found / Документ не знайдено', 'error')
      setLocalUploadDocId('')
      return
    }
    await uploadLocalFilesForDocument(targetDoc, selectedFiles)
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
              <span className={`side-badge ${sideClass(profile.side)}`}>{formatSideLabel(profile.side)}</span>
              <span className="role-badge">{ROLES[profile.role]?.pl}</span>
            </div>

            <NotificationsBell />

            {isSuperAdmin && (
              <>
                <button onClick={() => setShowUserManagement(true)} aria-label="Zarządzanie użytkownikami">👥</button>
                <button onClick={() => setShowAuditLog(true)} aria-label="Dziennik audytu">📜</button>
              </>
            )}
            {(isAdmin || normalizeSide(profile.side) === SIDE_FNU) && (
              <button onClick={() => setShowSectionManager(true)} aria-label="Zarządzanie sekcjami">📁</button>
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
              <div className="section-actions">
                <button type="button" className="section-comments-btn" onClick={() => setShowSectionComments(true)}>
                  💬 Komentarze sekcji / Коментарі секції
                </button>
                <button type="button" className="section-comments-btn" onClick={downloadSectionArchive} disabled={sectionToolsBusy || !canViewCurrentSection}>
                  📦 Download folder (.zip)
                </button>
              </div>
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

            {canManageCurrentSection && (
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

            <input
              ref={localUploadInputRef}
              type="file"
              accept={ALLOWED_EXTENSIONS.join(',')}
              multiple
              onChange={onLocalUploadInputChange}
              style={{ display: 'none' }}
              aria-hidden="true"
              tabIndex={-1}
            />

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
                        <span className={`side-badge small ${sideClass(doc.responsible.side)}`}>{formatSideLabel(doc.responsible.side)}</span>
                      </span>
                    )}
                    <div className="doc-row-actions">
                      <button
                        type="button"
                        className="doc-local-upload-btn"
                        onClick={e => {
                          e.stopPropagation()
                          openLocalUploadForDocument(doc)
                        }}
                        disabled={sectionToolsBusy || Boolean(localUploadBusyDocId) || !canUploadCurrentSection}
                        aria-label={`Upload pliku lokalnego do dokumentu ${doc.code}`}
                        title="Upload local file"
                      >
                        <LocalUploadIcon className="local-upload-icon" />
                        <span>{localUploadBusyDocId === doc.id ? 'Uploading...' : 'Upload'}</span>
                      </button>
                      <button
                        type="button"
                        className="doc-drive-import-btn"
                        onClick={e => {
                          e.stopPropagation()
                          importGoogleDriveForDocument(doc)
                        }}
                        disabled={sectionToolsBusy || !canUploadCurrentSection}
                        aria-label={`Import Google Drive do dokumentu ${doc.code}`}
                        title="Import Google Drive (file only)"
                      >
                        <GoogleDriveIcon className="drive-icon" />
                        <span>Import</span>
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
                    </div>
                    <select
                      value={doc.status || 'pending'}
                      onChange={e => { e.stopPropagation(); updateStatus(doc.id, e.target.value) }}
                      onClick={e => e.stopPropagation()}
                      disabled={!canManageCurrentSection}
                      aria-label={`Status dokumentu ${doc.code}`}
                    >
                      {STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.pl}</option>)}
                    </select>
                  </article>
                  {expandedDocId === doc.id && (
                    <InlineDocumentDrawer
                      document={doc}
                      onUpdate={loadDocuments}
                      displayLanguage={resolveLanguageMode('auto', profile?.side)}
                      permissions={{
                        can_comment: canCommentCurrentSection,
                        can_upload: canUploadCurrentSection,
                        can_manage: canManageCurrentSection,
                      }}
                    />
                  )}
                </div>
              ))}
              {filteredDocuments.length === 0 && <div className="no-docs"><BiText pl="Brak dokumentów" uk="Немає документів" /></div>}
            </div>
          </main>

          <aside className="right-rail" aria-label="Panel boczny / Бічна панель">
            <SmartInbox documents={documents} profile={profile} />
            <TaskBoard companyId={selectedCompany?.id} sectionId={activeSection?.id} />
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
            <SectionManager
              company={selectedCompany}
              sections={sections}
              onUpdate={loadSections}
              onClose={() => setShowSectionManager(false)}
              canManageMain={isAdmin}
            />
          </ErrorBoundary>
        )}
        {showSectionComments && activeSection && (
          <ErrorBoundary>
            <SectionCommentsModal
              section={activeSection}
              onClose={() => setShowSectionComments(false)}
              displayLanguage={resolveLanguageMode('auto', profile?.side)}
              canComment={canCommentCurrentSection}
            />
          </ErrorBoundary>
        )}
        {selectedDocument && (
          <ErrorBoundary>
            <DocumentDetail
              document={selectedDocument}
              onClose={() => setSelectedDocument(null)}
              onUpdate={loadDocuments}
              displayLanguage={resolveLanguageMode('auto', profile?.side)}
              permissions={{
                can_comment: canCommentCurrentSection,
                can_upload: canUploadCurrentSection,
                can_manage: canManageCurrentSection,
              }}
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
