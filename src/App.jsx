import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from 'react'
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

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100MB
const MAX_FILES_PER_DOC = 100
const MAX_COMMENT_LENGTH = 500

// Supported file types
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
  'pdf': '📕',
  'doc': '📘',
  'docx': '📘',
  'xls': '📗',
  'xlsx': '📗',
  'txt': '📄',
  'csv': '📊',
  'default': '📎'
}

// =====================================================
// BILINGUAL TEXT HELPER
// =====================================================
function BiText({ pl, uk, className = '' }) {
  return (
    <span className={`bi-text ${className}`}>
      <span className="text-pl">{pl}</span>
      <span className="text-uk">{uk}</span>
    </span>
  )
}

// =====================================================
// SECURITY UTILITIES
// =====================================================
function sanitizeFileName(originalName) {
  const uuid = crypto.randomUUID()
  const lastDot = originalName.lastIndexOf('.')
  let extension = lastDot > 0
    ? originalName.substring(lastDot).toLowerCase().replace(/[^a-z0-9.]/g, '')
    : ''
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    extension = '.bin'
  }
  return `${uuid}${extension}`
}

function getFileExtension(filename) {
  const lastDot = filename.lastIndexOf('.')
  return lastDot > 0 ? filename.substring(lastDot + 1).toLowerCase() : 'default'
}

function isValidFilePath(path) {
  if (!path || typeof path !== 'string') return false
  if (path.includes('..') || path.includes('//') || path.startsWith('/')) return false
  return /^[a-zA-Z0-9\-_./]+$/.test(path)
}

function isValidUUID(str) {
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

function sanitizeText(text) {
  if (!text || typeof text !== 'string') return ''
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#x27;').trim()
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
      <div className="toast-container">
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
    await supabase.from('audit_log').insert({ user_id: userId, action, entity_type: entityType, entity_id: entityId, details })
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
      <div className="auth-box">
        <h1>Audit System</h1>
        <p className="auth-subtitle">
          <span className="text-pl">System zarządzania dokumentami audytu</span><br/>
          <span className="text-uk">Система управління документами аудиту</span>
        </p>
        <form onSubmit={handleSubmit}>
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
          <input type="password" placeholder="Hasło / Пароль" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>{loading ? '...' : 'Zaloguj / Увійти'}</button>
        </form>
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
  const fileInputRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()

  const loadFiles = useCallback(async () => {
    if (!document?.id || !isValidUUID(document.id)) return

    let query = supabase.from('document_files').select('*').eq('document_id', document.id).order('created_at')

    // If OPERATOR, only show published files
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
          setFiles([])
          return
        }
      } else {
        setFiles([])
        return
      }
    }

    const { data } = await query
    setFiles(data || [])
  }, [document?.id, profile?.side])

  useEffect(() => { loadFiles() }, [loadFiles])

  const handleUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files)
    if (files.length + selectedFiles.length > MAX_FILES_PER_DOC) {
      addToast(`Maksymalnie ${MAX_FILES_PER_DOC} plików / Максимум ${MAX_FILES_PER_DOC} файлів`, 'error')
      return
    }

    setUploading(true)
    for (const file of selectedFiles) {
      const validation = validateFile(file)
      if (!validation.valid) { addToast(validation.error, 'error'); continue }

      const safeFileName = sanitizeFileName(file.name)
      const filePath = `${document.id}/${safeFileName}`

      const { error: uploadError } = await supabase.storage.from('documents').upload(filePath, file)

      if (!uploadError) {
        const ext = getFileExtension(file.name)
        const { data: fileData } = await supabase.from('document_files').insert({
          document_id: document.id,
          file_name: sanitizeText(file.name),
          file_path: filePath,
          file_size: file.size,
          file_type: ext,
          mime_type: file.type,
          uploaded_by: profile.id
        }).select().single()

        await logAudit(profile.id, 'upload_file', 'document_file', document.id, { file_name: file.name })
        addToast('Plik przesłany / Файл завантажено', 'success')

        // If FNU, file is not visible to OPERATOR by default
        if (profile.side === 'FNU' && fileData) {
          await supabase.from('document_access').insert({
            document_id: document.id,
            file_id: fileData.id,
            visible_to_operator: false
          })
        }
      } else {
        addToast('Błąd przesyłania / Помилка завантаження', 'error')
      }
    }
    setUploading(false)
    loadFiles()
    onUpdate?.()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDelete = async (fileId, filePath) => {
    if (!confirm('Usunąć plik? / Видалити файл?')) return
    await supabase.storage.from('documents').remove([filePath])
    await supabase.from('document_files').delete().eq('id', fileId)
    await logAudit(profile.id, 'delete_file', 'document_file', fileId)
    loadFiles()
    onUpdate?.()
    addToast('Plik usunięty / Файл видалено', 'success')
  }

  const handleDownload = async (filePath, fileName) => {
    const { data } = await supabase.storage.from('documents').download(filePath)
    if (data) {
      const url = URL.createObjectURL(data)
      const a = window.document.createElement('a')
      a.href = url; a.download = fileName; a.click()
      URL.revokeObjectURL(url)
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
    await supabase.from('document_access').upsert({
      document_id: document.id,
      file_id: fileId,
      visible_to_operator: true,
      published_at: new Date().toISOString(),
      published_by: profile.id
    }, { onConflict: 'document_id,file_id' })

    // Notify OPERATOR users
    const { data: operators } = await supabase.from('profiles').select('id').eq('side', 'OPERATOR').eq('is_active', true)
    if (operators) {
      for (const op of operators) {
        await supabase.from('notifications').insert({
          user_id: op.id,
          type: 'new_document',
          title: 'Nowe dokumenty / Нові документи',
          message: 'Dodano nowe dokumenty do przeglądu / Додано нові документи',
          entity_type: 'document',
          entity_id: document.id
        })
      }
    }
    addToast('Opublikowano dla OPERATOR / Опубліковано для OPERATOR', 'success')
    loadFiles()
  }

  if (!canView) return null

  return (
    <div className="file-upload">
      <div className="files-header">
        <BiText pl={`Pliki (${files.length}/${MAX_FILES_PER_DOC})`} uk={`Файли (${files.length}/${MAX_FILES_PER_DOC})`} />
        {canAdd && files.length < MAX_FILES_PER_DOC && (
          <label className="upload-btn">
            {uploading ? '...' : '+ Dodaj / Додати'}
            <input ref={fileInputRef} type="file" accept={ALLOWED_EXTENSIONS.join(',')} multiple onChange={handleUpload} disabled={uploading} style={{ display: 'none' }} />
          </label>
        )}
      </div>
      <ul className="files-list">
        {files.map(file => {
          const ext = file.file_type || getFileExtension(file.file_name)
          const icon = FILE_ICONS[ext] || FILE_ICONS.default
          return (
            <li key={file.id} className="file-item">
              <span className="file-icon">{icon}</span>
              <span className="file-name" title={file.file_name}>{file.file_name}</span>
              <span className="file-size">{(file.file_size / 1024 / 1024).toFixed(2)} MB</span>
              <div className="file-actions">
                <button onClick={() => handlePreview(file.file_path)} title="Podgląd / Перегляд">👁️</button>
                <button onClick={() => handleDownload(file.file_path, file.file_name)} title="Pobierz / Завантажити">⬇️</button>
                {canDelete && <button onClick={() => handleDelete(file.id, file.file_path)} title="Usuń / Видалити">🗑️</button>}
                {profile?.side === 'FNU' && profile?.role === 'super_admin' && (
                  <button onClick={() => publishToOperator(file.id)} title="Opublikuj dla OPERATOR" className="btn-publish">📤</button>
                )}
              </div>
            </li>
          )
        })}
        {files.length === 0 && <li className="no-files"><BiText pl="Brak plików" uk="Немає файлів" /></li>}
      </ul>
    </div>
  )
}

// =====================================================
// COMMENTS COMPONENT
// =====================================================
function Comments({ document, canComment, canView }) {
  const [comments, setComments] = useState([])
  const [newComment, setNewComment] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const addToast = useToast()
  const profile = useProfile()

  const loadComments = useCallback(async () => {
    if (!document?.id) return
    const { data } = await supabase
      .from('comments')
      .select('*, author:author_id(full_name, email, side)')
      .eq('document_id', document.id)
      .order('created_at')

    // Filter by visibility
    const filtered = (data || []).filter(c => {
      if (profile?.role === 'super_admin') return true
      if (!c.visible_to_sides) return true
      return c.visible_to_sides.includes(profile?.side)
    })
    setComments(filtered)
  }, [document?.id, profile])

  useEffect(() => { if (canView) loadComments() }, [canView, loadComments])

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!newComment.trim() || newComment.length > MAX_COMMENT_LENGTH) return
    setSubmitting(true)

    const { data, error } = await supabase.from('comments').insert({
      document_id: document.id,
      author_id: profile.id,
      content: sanitizeText(newComment.trim()),
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
    const newSides = currentSides.includes('OPERATOR')
      ? ['FNU']
      : ['FNU', 'OPERATOR']
    await supabase.from('comments').update({ visible_to_sides: newSides }).eq('id', commentId)
    loadComments()
    addToast('Widoczność zmieniona / Видимість змінено', 'success')
  }

  if (!canView) return null

  const topLevel = comments.filter(c => !c.parent_comment_id)
  const getReplies = (parentId) => comments.filter(c => c.parent_comment_id === parentId)

  const renderComment = (comment, isReply = false) => (
    <div key={comment.id} className={`comment ${isReply ? 'reply' : ''}`}>
      <div className="comment-header">
        <span className="comment-author">
          {comment.author?.full_name || comment.author?.email}
          <span className={`side-badge ${comment.author?.side?.toLowerCase()}`}>{comment.author?.side}</span>
        </span>
        <time>{new Date(comment.created_at).toLocaleString()}</time>
      </div>
      <p className="comment-content">{comment.content}</p>
      <div className="comment-actions">
        {canComment && !isReply && (
          <button onClick={() => setReplyTo(comment.id)}>↩️ Odpowiedz / Відповісти</button>
        )}
        {profile?.role === 'super_admin' && (
          <button onClick={() => toggleVisibility(comment.id, comment.visible_to_sides || [])}>
            {(comment.visible_to_sides || []).includes('OPERATOR') ? '🔓 Widoczny dla OPERATOR' : '🔒 Tylko FNU'}
          </button>
        )}
      </div>
      {getReplies(comment.id).map(r => renderComment(r, true))}
    </div>
  )

  return (
    <section className="comments-section">
      <h4><BiText pl={`Komentarze (${comments.length})`} uk={`Коментарі (${comments.length})`} /></h4>

      {canComment && (
        <form onSubmit={handleSubmit} className="comment-form">
          {replyTo && (
            <div className="replying-to">
              <BiText pl="Odpowiedź na komentarz" uk="Відповідь на коментар" />
              <button type="button" onClick={() => setReplyTo(null)}>✕</button>
            </div>
          )}
          <textarea value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Napisz komentarz... / Напишіть коментар..." maxLength={MAX_COMMENT_LENGTH} />
          <div className="comment-footer">
            <span>{newComment.length}/{MAX_COMMENT_LENGTH}</span>
            <button type="submit" disabled={submitting || !newComment.trim()}>
              {submitting ? '...' : 'Wyślij / Надіслати'}
            </button>
          </div>
        </form>
      )}

      <div className="comments-list">
        {topLevel.map(c => renderComment(c))}
        {comments.length === 0 && <div className="no-comments"><BiText pl="Brak komentarzy" uk="Немає коментарів" /></div>}
      </div>
    </section>
  )
}

// =====================================================
// CHAT COMPONENT
// =====================================================
function Chat({ onClose }) {
  const [messages, setMessages] = useState([])
  const [users, setUsers] = useState([])
  const [selectedUser, setSelectedUser] = useState(null)
  const [newMessage, setNewMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [allowedRecipients, setAllowedRecipients] = useState([])
  const messagesEndRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()

  useEffect(() => {
    loadUsers()
    loadAllowedRecipients()
  }, [])

  useEffect(() => {
    if (selectedUser) loadMessages()
    const interval = setInterval(() => { if (selectedUser) loadMessages() }, 5000)
    return () => clearInterval(interval)
  }, [selectedUser])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const loadUsers = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name, email, side, role').eq('is_active', true).neq('id', profile?.id)
    setUsers(data || [])
  }

  const loadAllowedRecipients = async () => {
    if (profile?.role === 'super_admin') {
      // Super admin can message everyone
      const { data } = await supabase.from('profiles').select('id').eq('is_active', true).neq('id', profile?.id)
      setAllowedRecipients((data || []).map(u => u.id))
    } else {
      const { data } = await supabase.from('chat_permissions').select('can_message_user_id').eq('user_id', profile?.id)
      setAllowedRecipients((data || []).map(p => p.can_message_user_id))
    }
  }

  const loadMessages = async () => {
    if (!selectedUser) return
    const { data } = await supabase
      .from('chat_messages')
      .select('*, sender:sender_id(full_name, email, side)')
      .or(`and(sender_id.eq.${profile?.id},recipient_id.eq.${selectedUser}),and(sender_id.eq.${selectedUser},recipient_id.eq.${profile?.id})`)
      .order('created_at')
    setMessages(data || [])

    // Mark as read
    await supabase.from('chat_messages').update({ is_read: true }).eq('recipient_id', profile?.id).eq('sender_id', selectedUser)
  }

  const sendMessage = async (e) => {
    e.preventDefault()
    if (!newMessage.trim() || !selectedUser) return
    setSending(true)

    await supabase.from('chat_messages').insert({
      sender_id: profile.id,
      recipient_id: selectedUser,
      content: sanitizeText(newMessage.trim())
    })

    setNewMessage('')
    loadMessages()
    setSending(false)
  }

  const filteredUsers = users.filter(u => allowedRecipients.includes(u.id) || profile?.role === 'super_admin')

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <BiText pl="Czat" uk="Чат" />
        <button onClick={onClose}>✕</button>
      </div>

      <div className="chat-body">
        <div className="chat-users">
          <h5><BiText pl="Kontakty" uk="Контакти" /></h5>
          {filteredUsers.map(u => (
            <div key={u.id} className={`chat-user ${selectedUser === u.id ? 'active' : ''}`} onClick={() => setSelectedUser(u.id)}>
              <span className="user-name">{u.full_name || u.email}</span>
              <span className={`side-badge ${u.side?.toLowerCase()}`}>{u.side}</span>
            </div>
          ))}
          {filteredUsers.length === 0 && <div className="no-contacts"><BiText pl="Brak kontaktów" uk="Немає контактів" /></div>}
        </div>

        <div className="chat-messages">
          {selectedUser ? (
            <>
              <div className="messages-list">
                {messages.map(m => (
                  <div key={m.id} className={`message ${m.sender_id === profile?.id ? 'sent' : 'received'}`}>
                    <div className="message-header">
                      <span className="message-sender">{m.sender?.full_name || m.sender?.email}</span>
                      <span className={`side-badge ${m.sender?.side?.toLowerCase()}`}>{m.sender?.side}</span>
                    </div>
                    <p className="message-content">{m.content}</p>
                    <time className="message-time">{new Date(m.created_at).toLocaleString()}</time>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              <form onSubmit={sendMessage} className="message-form">
                <input value={newMessage} onChange={e => setNewMessage(e.target.value)} placeholder="Napisz wiadomość... / Напишіть повідомлення..." />
                <button type="submit" disabled={sending || !newMessage.trim()}>📤</button>
              </form>
            </>
          ) : (
            <div className="select-user"><BiText pl="Wybierz kontakt" uk="Виберіть контакт" /></div>
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
  const [editingPermissions, setEditingPermissions] = useState(null)
  const modalRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()

  useFocusTrap(modalRef, true)

  useEffect(() => { loadUsers() }, [])

  const loadUsers = async () => {
    const { data } = await supabase.from('profiles').select('*').order('created_at', { ascending: false })
    setUsers(data || [])
    setLoading(false)
  }

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
          phone: newUser.phone,
          position: newUser.position,
          company_name: newUser.company_name,
          role: newUser.role,
          side: newUser.side,
          is_active: true
        })
        await logAudit(profile.id, 'create_user', 'profile', data.user.id)
      }

      setNewUser({ email: '', password: '', full_name: '', phone: '', position: '', company_name: '', role: 'user_fnu', side: 'FNU' })
      loadUsers()
      addToast('Użytkownik utworzony / Користувача створено', 'success')
    } catch (err) { addToast('Błąd: ' + err.message, 'error') }
    setCreating(false)
  }

  const updateUser = async (userId, updates) => {
    await supabase.from('profiles').update(updates).eq('id', userId)
    await logAudit(profile.id, 'update_user', 'profile', userId, updates)
    loadUsers()
    addToast('Zaktualizowano / Оновлено', 'success')
  }

  const toggleActive = async (userId, isActive) => {
    await updateUser(userId, { is_active: !isActive })
  }

  if (loading) return <div className="loading">Ładowanie... / Завантаження...</div>

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal user-management wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2><BiText pl="Zarządzanie użytkownikami" uk="Управління користувачами" /></h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="add-user-section">
            <h4><BiText pl="Nowy użytkownik" uk="Новий користувач" /></h4>
            <form onSubmit={createUser} className="user-form">
              <div className="form-grid">
                <input placeholder="Email" type="email" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} required />
                <input placeholder="Hasło / Пароль" type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} required minLength={6} />
                <input placeholder="Imię i nazwisko / Ім'я" value={newUser.full_name} onChange={e => setNewUser({...newUser, full_name: e.target.value})} required />
                <input placeholder="Telefon / Телефон" value={newUser.phone} onChange={e => setNewUser({...newUser, phone: e.target.value})} />
                <input placeholder="Stanowisko / Посада" value={newUser.position} onChange={e => setNewUser({...newUser, position: e.target.value})} />
                <input placeholder="Firma / Компанія" value={newUser.company_name} onChange={e => setNewUser({...newUser, company_name: e.target.value})} />
                <select value={newUser.side} onChange={e => setNewUser({...newUser, side: e.target.value})}>
                  {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                </select>
                <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})}>
                  {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                </select>
              </div>
              <button type="submit" className="btn-primary" disabled={creating}>{creating ? '...' : 'Utwórz / Створити'}</button>
            </form>
          </div>

          <h4><BiText pl={`Lista użytkowników (${users.length})`} uk={`Список користувачів (${users.length})`} /></h4>
          <div className="users-table-container">
            <table className="users-table">
              <thead>
                <tr>
                  <th>Imię / Ім'я</th>
                  <th>Email</th>
                  <th>Telefon</th>
                  <th>Stanowisko</th>
                  <th>Strona / Сторона</th>
                  <th>Rola / Роль</th>
                  <th>Status</th>
                  <th>Akcje / Дії</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className={u.is_active ? '' : 'inactive'}>
                    <td>{u.full_name || '—'}</td>
                    <td>{u.email}</td>
                    <td>{u.phone || '—'}</td>
                    <td>{u.position || '—'}</td>
                    <td>
                      <select value={u.side || 'FNU'} onChange={e => updateUser(u.id, { side: e.target.value })} className={`side-select ${u.side?.toLowerCase()}`}>
                        {Object.entries(SIDES).map(([k, v]) => <option key={k} value={k}>{k}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={u.role} onChange={e => updateUser(u.id, { role: e.target.value })} disabled={u.id === profile?.id}>
                        {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v.pl}</option>)}
                      </select>
                    </td>
                    <td><span className={`status-badge ${u.is_active ? 'active' : 'inactive'}`}>{u.is_active ? 'Aktywny' : 'Nieaktywny'}</span></td>
                    <td>
                      {u.id !== profile?.id && (
                        <button onClick={() => toggleActive(u.id, u.is_active)} className={u.is_active ? 'btn-danger' : 'btn-success'}>
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
// AUDIT LOG COMPONENT (Super Admin only)
// =====================================================
function AuditLog({ onClose }) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const debouncedFilter = useDebounce(filter, 300)
  const modalRef = useRef(null)

  useFocusTrap(modalRef, true)

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase.from('audit_log').select('*, user:user_id(full_name, email, side)').order('created_at', { ascending: false }).limit(500)
      setLogs(data || [])
      setLoading(false)
    }
    load()
  }, [])

  const actionLabels = {
    'upload_file': '📤 Przesłanie pliku / Завантаження файлу',
    'delete_file': '🗑️ Usunięcie pliku / Видалення файлу',
    'download_file': '⬇️ Pobranie pliku / Скачування файлу',
    'view_file': '👁️ Podgląd pliku / Перегляд файлу',
    'view_document': '👁️ Podgląd dokumentu / Перегляд документа',
    'update_status': '🔄 Zmiana statusu / Зміна статусу',
    'add_comment': '💬 Dodanie komentarza / Додано коментар',
    'create_user': '👤 Utworzenie użytkownika / Створення користувача',
    'update_user': '✏️ Aktualizacja użytkownika / Оновлення користувача'
  }

  const filtered = useMemo(() => {
    if (!debouncedFilter) return logs
    const lower = debouncedFilter.toLowerCase()
    return logs.filter(l => l.action?.includes(lower) || l.user?.email?.toLowerCase().includes(lower))
  }, [logs, debouncedFilter])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div ref={modalRef} className="modal audit-log wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2><BiText pl="Dziennik audytu" uk="Журнал аудиту" /></h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <input type="text" placeholder="Filtr... / Фільтр..." value={filter} onChange={e => setFilter(e.target.value)} className="filter-input" />
          {loading ? <div className="loading">...</div> : (
            <div className="audit-list">
              {filtered.map(log => (
                <div key={log.id} className="audit-item">
                  <div className="audit-header">
                    <span className="audit-action">{actionLabels[log.action] || log.action}</span>
                    <time>{new Date(log.created_at).toLocaleString()}</time>
                  </div>
                  <div className="audit-user">
                    {log.user?.full_name || log.user?.email || 'System'}
                    {log.user?.side && <span className={`side-badge ${log.user.side.toLowerCase()}`}>{log.user.side}</span>}
                  </div>
                  {log.details && <pre className="audit-details">{JSON.stringify(log.details, null, 2)}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// =====================================================
// DOCUMENT DETAIL MODAL
// =====================================================
function DocumentDetail({ document, onClose, onUpdate }) {
  const [doc, setDoc] = useState(document)
  const [users, setUsers] = useState([])
  const modalRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()

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
    supabase.from('profiles').select('id, full_name, email, side').eq('is_active', true).then(({ data }) => setUsers(data || []))
    logAudit(profile?.id, 'view_document', 'document', document.id)
  }, [])

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
      <div ref={modalRef} className="modal document-detail" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="doc-code">{doc.code}</span>
            <h3 className="doc-title-pl">{doc.name_pl}</h3>
            <p className="doc-title-uk">{doc.name_uk}</p>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="doc-meta">
            <div className="meta-item">
              <label><BiText pl="Status" uk="Статус" /></label>
              <select value={doc.status || 'pending'} onChange={e => updateStatus(e.target.value)} disabled={!isAdmin}>
                {STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.pl} / {opt.uk}</option>)}
              </select>
            </div>
            <div className="meta-item">
              <label><BiText pl="Odpowiedzialny" uk="Відповідальний" /></label>
              <select value={doc.responsible_user_id || ''} onChange={e => updateResponsible(e.target.value)} disabled={!isAdmin}>
                <option value="">— Nie przypisano / Не призначено —</option>
                {users.map(u => <option key={u.id} value={u.id}>{u.full_name || u.email} ({u.side})</option>)}
              </select>
            </div>
          </div>

          <FileUpload document={doc} onUpdate={onUpdate} canAdd={canAdd} canDelete={canDelete} canView={canView} />
          <Comments document={doc} canComment={canComment} canView={canView} />
        </div>
      </div>
    </div>
  )
}

// =====================================================
// SECTION MANAGER (for Super Admin)
// =====================================================
function SectionManager({ company, sections, onUpdate, onClose }) {
  const [newSection, setNewSection] = useState({ code: '', name_pl: '', name_uk: '' })
  const [creating, setCreating] = useState(false)
  const modalRef = useRef(null)
  const addToast = useToast()
  const profile = useProfile()

  useFocusTrap(modalRef, true)

  const createSection = async (e) => {
    e.preventDefault()
    setCreating(true)
    const { data, error } = await supabase.from('document_sections').insert({
      company_id: company.id,
      code: newSection.code,
      name_pl: newSection.name_pl,
      name_uk: newSection.name_uk,
      order_index: sections.length + 1,
      created_by: profile.id
    }).select().single()

    if (!error && data) {
      setNewSection({ code: '', name_pl: '', name_uk: '' })
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
      <div ref={modalRef} className="modal section-manager" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2><BiText pl="Zarządzanie sekcjami" uk="Управління розділами" /></h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <form onSubmit={createSection} className="section-form">
            <input placeholder="Kod (np. A)" value={newSection.code} onChange={e => setNewSection({...newSection, code: e.target.value})} required />
            <input placeholder="Nazwa (PL)" value={newSection.name_pl} onChange={e => setNewSection({...newSection, name_pl: e.target.value})} required />
            <input placeholder="Назва (UK)" value={newSection.name_uk} onChange={e => setNewSection({...newSection, name_uk: e.target.value})} required />
            <button type="submit" disabled={creating}>{creating ? '...' : '+ Dodaj / Додати'}</button>
          </form>

          <div className="sections-list">
            {sections.map(s => (
              <div key={s.id} className="section-item">
                <span className="section-code">{s.code}</span>
                <span className="section-name">{s.name_pl} / {s.name_uk}</span>
                <button onClick={() => deleteSection(s.id)} className="btn-danger">🗑️</button>
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

  useEffect(() => {
    const load = async () => {
      if (!profile?.id) return
      const { data } = await supabase.from('notifications').select('*').eq('user_id', profile.id).eq('is_read', false).order('created_at', { ascending: false }).limit(10)
      setNotifications(data || [])
    }
    load()
    const interval = setInterval(load, 30000)
    return () => clearInterval(interval)
  }, [profile?.id])

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
      <button onClick={() => setShowDropdown(!showDropdown)} className="bell-btn">
        🔔 {notifications.length > 0 && <span className="badge">{notifications.length}</span>}
      </button>
      {showDropdown && (
        <div className="notifications-dropdown">
          <div className="notif-header">
            <BiText pl="Powiadomienia" uk="Сповіщення" />
            {notifications.length > 0 && <button onClick={markAllRead}>Oznacz wszystkie / Прочитати все</button>}
          </div>
          {notifications.length === 0 ? (
            <div className="no-notif"><BiText pl="Brak powiadomień" uk="Немає сповіщень" /></div>
          ) : (
            notifications.map(n => (
              <div key={n.id} className="notif-item" onClick={() => markAsRead(n.id)}>
                <strong>{n.title}</strong>
                <p>{n.message}</p>
                <time>{new Date(n.created_at).toLocaleString()}</time>
              </div>
            ))
          )}
        </div>
      )}
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
  const [showUserManagement, setShowUserManagement] = useState(false)
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [showSectionManager, setShowSectionManager] = useState(false)
  const [showChat, setShowChat] = useState(false)
  const addToast = useToast()

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
    setProfile(data)
    loadCompanies()
  }

  const loadCompanies = async () => {
    const { data } = await supabase.from('companies').select('*').order('order_index')
    setCompanies(data || [])
    if (data?.length > 0) setSelectedCompany(data[0])
    setLoading(false)
  }

  const loadSections = useCallback(async () => {
    if (!selectedCompany) return
    const { data } = await supabase.from('document_sections').select('*').eq('company_id', selectedCompany.id).is('parent_section_id', null).order('order_index')
    setSections(data || [])
    if (data?.length > 0 && !activeSection) setActiveSection(data[0])
  }, [selectedCompany])

  useEffect(() => { if (selectedCompany) loadSections() }, [selectedCompany, loadSections])

  const loadDocuments = useCallback(async () => {
    if (!activeSection) return
    const { data: subSections } = await supabase.from('document_sections').select('id').eq('parent_section_id', activeSection.id)
    const sectionIds = [activeSection.id, ...(subSections || []).map(s => s.id)]
    const { data } = await supabase.from('documents').select('*, responsible:profiles!documents_responsible_user_id_fkey(full_name, email, side)').in('section_id', sectionIds).order('order_index')
    setDocuments(data || [])
  }, [activeSection])

  useEffect(() => { if (activeSection) loadDocuments() }, [activeSection, loadDocuments])

  const updateStatus = async (docId, status) => {
    await supabase.from('documents').update({ status, updated_at: new Date().toISOString() }).eq('id', docId)
    await logAudit(profile.id, 'update_status', 'document', docId, { status })
    loadDocuments()
  }

  if (loading) return <div className="loading">Ładowanie... / Завантаження...</div>
  if (!session) return <Auth />
  if (!profile) return <div className="loading">Ładowanie profilu... / Завантаження профілю...</div>

  const isSuperAdmin = profile.role === 'super_admin'
  const isAdmin = isSuperAdmin || profile.role === 'lawyer_admin'
  const totalDocs = documents.length
  const completedDocs = documents.filter(d => d.status === 'done').length
  const progress = totalDocs > 0 ? Math.round((completedDocs / totalDocs) * 100) : 0

  return (
    <ProfileContext.Provider value={profile}>
      <div className="app">
        <header>
          <div className="header-left">
            <h1>Audit System</h1>
            <select value={selectedCompany?.id || ''} onChange={e => setSelectedCompany(companies.find(c => c.id === e.target.value))}>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name_pl} / {c.name_uk}</option>)}
            </select>
          </div>

          <div className="header-right">
            <div className="user-info">
              <span className="user-name">{profile.full_name || profile.email}</span>
              <span className={`side-badge ${profile.side?.toLowerCase()}`}>{profile.side}</span>
              <span className="role-badge">{ROLES[profile.role]?.pl}</span>
            </div>

            <NotificationsBell />

            {isSuperAdmin && (
              <>
                <button onClick={() => setShowUserManagement(true)} title="Użytkownicy / Користувачі">👥</button>
                <button onClick={() => setShowAuditLog(true)} title="Dziennik audytu / Журнал аудиту">📜</button>
                <button onClick={() => setShowSectionManager(true)} title="Sekcje / Розділи">📁</button>
              </>
            )}

            <button onClick={() => setShowChat(true)} title="Czat / Чат">💬</button>
            <button onClick={() => supabase.auth.signOut()} title="Wyloguj / Вийти">🚪</button>
          </div>
        </header>

        <div className="progress-bar">
          <div className="progress-track"><div className="progress" style={{ width: `${progress}%` }} /></div>
          <span>{completedDocs} / {totalDocs} ({progress}%)</span>
        </div>

        <nav className="sections-nav">
          {sections.map(s => (
            <button key={s.id} className={activeSection?.id === s.id ? 'active' : ''} onClick={() => setActiveSection(s)}>
              <span className="section-code">{s.code}.</span>
              <span className="section-name-pl">{s.name_pl}</span>
              <span className="section-name-uk">{s.name_uk}</span>
            </button>
          ))}
        </nav>

        <main>
          <div className="section-header">
            <h2>
              <span className="code">{activeSection?.code}.</span>
              <span className="name-pl">{activeSection?.name_pl}</span>
              <span className="name-uk">{activeSection?.name_uk}</span>
            </h2>
          </div>

          <div className="documents-list">
            {documents.map(doc => (
              <div key={doc.id} className={`doc-item ${doc.status || 'pending'}`} onClick={() => setSelectedDocument(doc)}>
                <div className="doc-info">
                  <span className="doc-code">{doc.code}</span>
                  <div className="doc-names">
                    <span className="name-pl">{doc.name_pl}</span>
                    <span className="name-uk">{doc.name_uk}</span>
                  </div>
                </div>
                {doc.responsible && (
                  <span className="doc-responsible">
                    {doc.responsible.full_name || doc.responsible.email}
                    <span className={`side-badge small ${doc.responsible.side?.toLowerCase()}`}>{doc.responsible.side}</span>
                  </span>
                )}
                <select value={doc.status || 'pending'} onChange={e => { e.stopPropagation(); updateStatus(doc.id, e.target.value) }} onClick={e => e.stopPropagation()} disabled={!isAdmin}>
                  {STATUS_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.pl}</option>)}
                </select>
              </div>
            ))}
            {documents.length === 0 && <div className="no-docs"><BiText pl="Brak dokumentów" uk="Немає документів" /></div>}
          </div>
        </main>

        {showUserManagement && <UserManagement onClose={() => setShowUserManagement(false)} />}
        {showAuditLog && <AuditLog onClose={() => setShowAuditLog(false)} />}
        {showSectionManager && selectedCompany && <SectionManager company={selectedCompany} sections={sections} onUpdate={loadSections} onClose={() => setShowSectionManager(false)} />}
        {selectedDocument && <DocumentDetail document={selectedDocument} onClose={() => setSelectedDocument(null)} onUpdate={loadDocuments} />}
        {showChat && <Chat onClose={() => setShowChat(false)} />}
      </div>
    </ProfileContext.Provider>
  )
}

// =====================================================
// APP WITH PROVIDERS
// =====================================================
export default function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  )
}
