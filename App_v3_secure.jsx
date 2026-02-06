import { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from 'react'
import { supabase } from './lib/supabase'

// =====================================================
// CONSTANTS
// =====================================================
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

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB
const MAX_FILES_PER_DOC = 10
const MAX_COMMENT_LENGTH = 250
const ALLOWED_FILE_TYPES = ['application/pdf']
const ALLOWED_EXTENSIONS = ['.pdf']

// =====================================================
// SECURITY UTILITIES
// =====================================================

/**
 * Sanitize filename to prevent path traversal attacks
 * Uses UUID-based naming for secure file storage
 */
function sanitizeFileName(originalName) {
  const uuid = crypto.randomUUID()
  const lastDot = originalName.lastIndexOf('.')
  let extension = lastDot > 0
    ? originalName.substring(lastDot).toLowerCase().replace(/[^a-z0-9.]/g, '')
    : ''

  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    extension = '.pdf'
  }
  return `${uuid}${extension}`
}

/**
 * Validate file path to prevent traversal
 */
function isValidFilePath(path) {
  if (!path || typeof path !== 'string') return false
  if (path.includes('..') || path.includes('//') || path.startsWith('/')) {
    return false
  }
  const safePathRegex = /^[a-zA-Z0-9\-_./]+$/
  return safePathRegex.test(path)
}

/**
 * Validate UUID format
 */
function isValidUUID(str) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  return uuidRegex.test(str)
}

/**
 * Validate file type and size
 */
function validateFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `Файл перевищує 50MB / Plik przekracza 50MB` }
  }
  if (!ALLOWED_FILE_TYPES.includes(file.type)) {
    return { valid: false, error: 'Тільки PDF файли / Tylko pliki PDF' }
  }
  return { valid: true }
}

/**
 * Sanitize text to prevent XSS
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .trim()
}

// =====================================================
// CUSTOM HOOKS
// =====================================================

/**
 * Debounce hook for search/filter inputs
 */
function useDebounce(value, delay = 300) {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return debouncedValue
}

/**
 * Focus trap hook for modals (accessibility)
 */
function useFocusTrap(ref, isActive) {
  useEffect(() => {
    if (!isActive || !ref.current) return

    const modal = ref.current
    const focusableElements = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    const firstElement = focusableElements[0]
    const lastElement = focusableElements[focusableElements.length - 1]

    const handleKeyDown = (e) => {
      if (e.key === 'Tab') {
        if (e.shiftKey && document.activeElement === firstElement) {
          e.preventDefault()
          lastElement?.focus()
        } else if (!e.shiftKey && document.activeElement === lastElement) {
          e.preventDefault()
          firstElement?.focus()
        }
      }
    }

    firstElement?.focus()
    modal.addEventListener('keydown', handleKeyDown)
    return () => modal.removeEventListener('keydown', handleKeyDown)
  }, [ref, isActive])
}

/**
 * Abort controller hook for async requests
 */
function useAbortController() {
  const controllerRef = useRef(null)

  const getSignal = useCallback(() => {
    if (controllerRef.current) {
      controllerRef.current.abort()
    }
    controllerRef.current = new AbortController()
    return controllerRef.current.signal
  }, [])

  useEffect(() => {
    return () => {
      if (controllerRef.current) {
        controllerRef.current.abort()
      }
    }
  }, [])

  return getSignal
}

// =====================================================
// CONTEXT
// =====================================================

const ToastContext = createContext(null)

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback((message, type = 'info') => {
    const id = Date.now()
    setToasts(prev => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 3000)
  }, [])

  return (
    <ToastContext.Provider value={addToast}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {toasts.map(toast => (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function useToast() {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast must be used within ToastProvider')
  return context
}

// =====================================================
// AUDIT LOGGING
// =====================================================
async function logAudit(userId, action, entityType, entityId, details = null) {
  if (!isValidUUID(userId)) return
  try {
    await supabase.from('audit_log').insert({
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details
    })
  } catch (error) {
    console.error('Audit log error:', error)
  }
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
    } catch (err) {
      setError(err.message)
    }
    setLoading(false)
  }

  return (
    <div className="auth-container">
      <div className="auth-box">
        <h1>Audit System</h1>
        <p>Система управління документами<br/>System zarządzania dokumentami</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="email" className="visually-hidden">Email</label>
          <input
            id="email"
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <label htmlFor="password" className="visually-hidden">Пароль / Haslo</label>
          <input
            id="password"
            type="password"
            placeholder="Пароль / Haslo"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
          {error && <div className="error" role="alert">{error}</div>}
          <button type="submit" disabled={loading}>
            {loading ? '...' : 'Увійти / Zaloguj'}
          </button>
        </form>
      </div>
    </div>
  )
}

// =====================================================
// FILE UPLOAD COMPONENT (with path traversal fix)
// =====================================================
function FileUpload({ document, profile, onUpdate, canEdit }) {
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)
  const addToast = useToast()

  const loadFiles = useCallback(async () => {
    if (!isValidUUID(document.id)) return
    const { data } = await supabase
      .from('document_files')
      .select('*')
      .eq('document_id', document.id)
      .order('created_at')
    setFiles(data || [])
  }, [document.id])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  const handleUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files)
    if (files.length + selectedFiles.length > MAX_FILES_PER_DOC) {
      addToast(`Максимум ${MAX_FILES_PER_DOC} файлів / Maximum ${MAX_FILES_PER_DOC} plików`, 'error')
      return
    }

    setUploading(true)
    for (const file of selectedFiles) {
      const validation = validateFile(file)
      if (!validation.valid) {
        addToast(validation.error, 'error')
        continue
      }

      // SECURITY FIX: Use UUID-based filename instead of user-provided name
      const safeFileName = sanitizeFileName(file.name)
      const filePath = `${document.id}/${safeFileName}`

      // Validate the constructed path
      if (!isValidFilePath(filePath)) {
        addToast('Недійсний шлях файлу / Nieprawidlowa sciezka pliku', 'error')
        continue
      }

      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(filePath, file)

      if (!uploadError) {
        await supabase.from('document_files').insert({
          document_id: document.id,
          file_name: sanitizeText(file.name), // Store original name for display
          file_path: filePath, // Store safe path
          file_size: file.size,
          uploaded_by: profile.id
        })
        await logAudit(profile.id, 'upload_file', 'document_file', document.id, { file_name: file.name })
        addToast('Файл завантажено / Plik przeslany', 'success')
      } else {
        addToast('Помилка завантаження / Blad przesylania', 'error')
      }
    }
    setUploading(false)
    loadFiles()
    onUpdate()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDelete = async (fileId, filePath) => {
    if (!confirm('Видалити файл? / Usunac plik?')) return
    if (!isValidFilePath(filePath)) {
      addToast('Недійсний шлях файлу', 'error')
      return
    }

    await supabase.storage.from('documents').remove([filePath])
    await supabase.from('document_files').delete().eq('id', fileId)
    await logAudit(profile.id, 'delete_file', 'document_file', fileId, { file_path: filePath })
    loadFiles()
    onUpdate()
    addToast('Файл видалено / Plik usuniety', 'success')
  }

  const handleDownload = async (filePath, fileName) => {
    if (!isValidFilePath(filePath)) return
    const { data } = await supabase.storage.from('documents').download(filePath)
    if (data) {
      const url = URL.createObjectURL(data)
      const a = window.document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      URL.revokeObjectURL(url)
      await logAudit(profile.id, 'download_file', 'document_file', document.id, { file_name: fileName })
    }
  }

  const handlePreview = async (filePath) => {
    if (!isValidFilePath(filePath)) return
    const { data } = await supabase.storage.from('documents').createSignedUrl(filePath, 3600)
    if (data?.signedUrl) {
      window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
      await logAudit(profile.id, 'view_file', 'document_file', document.id, { file_path: filePath })
    }
  }

  return (
    <div className="file-upload" role="region" aria-label="Файли / Pliki">
      <div className="files-header">
        <span>Файли / Pliki ({files.length}/{MAX_FILES_PER_DOC})</span>
        {canEdit && files.length < MAX_FILES_PER_DOC && (
          <label className="upload-btn" tabIndex={0} role="button" aria-label="Завантажити файл / Przeslij plik">
            {uploading ? '...' : '+'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              multiple
              onChange={handleUpload}
              disabled={uploading}
              style={{ display: 'none' }}
              aria-hidden="true"
            />
          </label>
        )}
      </div>
      <ul className="files-list" role="list">
        {files.map(file => (
          <li key={file.id} className="file-item" role="listitem">
            <span className="file-icon" aria-hidden="true">PDF</span>
            <span className="file-name" title={file.file_name}>{file.file_name}</span>
            <span className="file-size">{(file.file_size / 1024 / 1024).toFixed(1)}MB</span>
            <div className="file-actions" role="group" aria-label="File actions">
              <button
                onClick={() => handlePreview(file.file_path)}
                title="Переглянути / Podglad"
                aria-label={`Переглянути ${file.file_name}`}
              >
                View
              </button>
              <button
                onClick={() => handleDownload(file.file_path, file.file_name)}
                title="Завантажити / Pobierz"
                aria-label={`Завантажити ${file.file_name}`}
              >
                Download
              </button>
              {canEdit && (
                <button
                  onClick={() => handleDelete(file.id, file.file_path)}
                  title="Видалити / Usun"
                  aria-label={`Видалити ${file.file_name}`}
                >
                  Delete
                </button>
              )}
            </div>
          </li>
        ))}
        {files.length === 0 && <li className="no-files">Немає файлів / Brak plikow</li>}
      </ul>
    </div>
  )
}

// =====================================================
// COMMENTS COMPONENT (with SQL injection fix)
// =====================================================
function Comments({ document, profile, canComment, canView }) {
  const [comments, setComments] = useState([])
  const [newComment, setNewComment] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [unreadComments, setUnreadComments] = useState(new Set())
  const addToast = useToast()

  const loadComments = useCallback(async () => {
    if (!isValidUUID(document.id)) return
    const { data } = await supabase
      .from('comments')
      .select('*, author:author_id(full_name, email)')
      .eq('document_id', document.id)
      .order('created_at')
    setComments(data || [])
  }, [document.id])

  // SECURITY FIX: Load unread comments using .in() instead of string interpolation
  const loadUnreadComments = useCallback(async () => {
    if (!isValidUUID(profile.id) || !isValidUUID(document.id)) return

    // First get all comments for this document
    const { data: allComments } = await supabase
      .from('comments')
      .select('id')
      .eq('document_id', document.id)

    if (!allComments || allComments.length === 0) {
      setUnreadComments(new Set())
      return
    }

    const commentIds = allComments.map(c => c.id)

    // Then get which ones the user has read - using .in() for security
    const { data: readComments } = await supabase
      .from('comment_reads')
      .select('comment_id')
      .eq('user_id', profile.id)
      .in('comment_id', commentIds)  // SECURE: using .in() instead of string interpolation

    const readIds = new Set((readComments || []).map(r => r.comment_id))
    const unread = new Set(commentIds.filter(id => !readIds.has(id)))
    setUnreadComments(unread)
  }, [document.id, profile.id])

  useEffect(() => {
    if (canView) {
      loadComments()
      loadUnreadComments()
    }
  }, [canView, loadComments, loadUnreadComments])

  const markAsRead = async (commentId) => {
    if (!isValidUUID(commentId) || !isValidUUID(profile.id)) return
    if (unreadComments.has(commentId)) {
      await supabase.from('comment_reads').upsert({
        comment_id: commentId,
        user_id: profile.id
      })
      setUnreadComments(prev => {
        const next = new Set(prev)
        next.delete(commentId)
        return next
      })
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const trimmedComment = newComment.trim()
    if (!trimmedComment || trimmedComment.length > MAX_COMMENT_LENGTH) return

    setSubmitting(true)
    const { data, error } = await supabase.from('comments').insert({
      document_id: document.id,
      author_id: profile.id,
      content: sanitizeText(trimmedComment),
      parent_comment_id: replyTo
    }).select().single()

    if (!error && data) {
      await logAudit(profile.id, 'add_comment', 'comment', data.id, { document_id: document.id })
      setNewComment('')
      setReplyTo(null)
      loadComments()
      addToast('Коментар додано / Komentarz dodany', 'success')
    }
    setSubmitting(false)
  }

  if (!canView) return null

  const topLevelComments = comments.filter(c => !c.parent_comment_id)
  const getReplies = (parentId) => comments.filter(c => c.parent_comment_id === parentId)

  const renderComment = (comment, isReply = false) => (
    <div
      key={comment.id}
      className={`comment ${isReply ? 'reply' : ''} ${unreadComments.has(comment.id) ? 'unread' : ''}`}
      onClick={() => markAsRead(comment.id)}
      role="article"
      aria-label={`Коментар від ${comment.author?.full_name || comment.author?.email}`}
    >
      {unreadComments.has(comment.id) && <span className="new-badge" aria-label="Новий коментар">NEW</span>}
      <div className="comment-header">
        <span className="comment-author">{comment.author?.full_name || comment.author?.email}</span>
        <time className="comment-date" dateTime={comment.created_at}>
          {new Date(comment.created_at).toLocaleString()}
        </time>
      </div>
      <p className="comment-content">{comment.content}</p>
      {canComment && !isReply && (
        <button
          className="reply-btn"
          onClick={(e) => { e.stopPropagation(); setReplyTo(comment.id) }}
          aria-label="Відповісти на коментар"
        >
          Відповісти / Odpowiedz
        </button>
      )}
      {getReplies(comment.id).map(reply => renderComment(reply, true))}
    </div>
  )

  return (
    <section className="comments-section" aria-label="Коментарі / Komentarze">
      <h4>Коментарі / Komentarze ({comments.length})</h4>

      {canComment && (
        <form onSubmit={handleSubmit} className="comment-form">
          {replyTo && (
            <div className="replying-to" role="status">
              Відповідь на коментар / Odpowiedz na komentarz
              <button type="button" onClick={() => setReplyTo(null)} aria-label="Скасувати відповідь">X</button>
            </div>
          )}
          <label htmlFor="new-comment" className="visually-hidden">Новий коментар</label>
          <textarea
            id="new-comment"
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            placeholder="Напишіть коментар... / Napisz komentarz..."
            maxLength={MAX_COMMENT_LENGTH}
            aria-describedby="char-count"
          />
          <div className="comment-footer">
            <span id="char-count" className="char-count" aria-live="polite">
              {newComment.length}/{MAX_COMMENT_LENGTH}
            </span>
            <button type="submit" disabled={submitting || !newComment.trim()}>
              {submitting ? '...' : 'Надіслати / Wyslij'}
            </button>
          </div>
        </form>
      )}

      <div className="comments-list" role="feed" aria-label="Список коментарів">
        {topLevelComments.map(comment => renderComment(comment))}
        {comments.length === 0 && <div className="no-comments">Немає коментарів / Brak komentarzy</div>}
      </div>
    </section>
  )
}

// =====================================================
// DOCUMENT DETAIL MODAL
// =====================================================
function DocumentDetail({ document, profile, onClose, onUpdate }) {
  const [doc, setDoc] = useState(document)
  const [users, setUsers] = useState([])
  const [editingResponsible, setEditingResponsible] = useState(false)
  const modalRef = useRef(null)
  const addToast = useToast()

  const isAdmin = profile.role === 'super_admin' || profile.role === 'lawyer_admin'
  const isUserCat1 = profile.role === 'user_cat1'
  const canUpload = isAdmin || isUserCat1
  const canComment = !isUserCat1
  const canViewComments = !isUserCat1

  useFocusTrap(modalRef, true)

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.document.addEventListener('keydown', handleEscape)
    return () => window.document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  useEffect(() => {
    loadUsers()
    recordView()
  }, [])

  const loadUsers = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name, email').eq('is_active', true)
    setUsers(data || [])
  }

  const recordView = async () => {
    if (!isValidUUID(document.id) || !isValidUUID(profile.id)) return
    await supabase.from('document_views').upsert({
      document_id: document.id,
      user_id: profile.id,
      viewed_at: new Date().toISOString()
    }, { onConflict: 'document_id,user_id' })
    await logAudit(profile.id, 'view_document', 'document', document.id)
  }

  const updateResponsible = async (userId) => {
    if (userId && !isValidUUID(userId)) return
    await supabase.from('documents').update({
      responsible_user_id: userId || null,
      updated_at: new Date().toISOString()
    }).eq('id', doc.id)
    await logAudit(profile.id, 'update_responsible', 'document', doc.id, { responsible_user_id: userId })

    const user = users.find(u => u.id === userId)
    setDoc({ ...doc, responsible_user_id: userId, responsible: user })
    setEditingResponsible(false)
    onUpdate()
    addToast('Відповідального оновлено / Odpowiedzialny zaktualizowany', 'success')
  }

  const updateStatus = async (status) => {
    await supabase.from('documents').update({
      status,
      updated_at: new Date().toISOString()
    }).eq('id', doc.id)
    await logAudit(profile.id, 'update_status', 'document', doc.id, { status })
    setDoc({ ...doc, status })
    onUpdate()
    addToast('Статус оновлено / Status zaktualizowany', 'success')
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div
        ref={modalRef}
        className="modal document-detail"
        onClick={e => e.stopPropagation()}
        role="document"
      >
        <div className="modal-header">
          <div>
            <span className="doc-code">{doc.code}</span>
            <h3 id="modal-title">{doc.name_uk}</h3>
            <p className="doc-name-pl">{doc.name_pl}</p>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Закрити / Zamknij">X</button>
        </div>

        <div className="modal-body">
          <div className="doc-info-row">
            <div className="info-item">
              <label htmlFor="status-select">Статус / Status</label>
              <select
                id="status-select"
                value={doc.status || 'pending'}
                onChange={e => updateStatus(e.target.value)}
                disabled={!isAdmin}
              >
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.uk} / {opt.pl}</option>
                ))}
              </select>
            </div>

            <div className="info-item">
              <label>Відповідальний / Odpowiedzialny</label>
              {editingResponsible ? (
                <select
                  value={doc.responsible_user_id || ''}
                  onChange={e => updateResponsible(e.target.value)}
                  onBlur={() => setEditingResponsible(false)}
                  autoFocus
                  aria-label="Вибрати відповідального"
                >
                  <option value="">— Не призначено / Nie przypisano —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                  ))}
                </select>
              ) : (
                <div
                  className="responsible-display"
                  onClick={() => isAdmin && setEditingResponsible(true)}
                  role={isAdmin ? 'button' : undefined}
                  tabIndex={isAdmin ? 0 : undefined}
                  onKeyDown={e => isAdmin && e.key === 'Enter' && setEditingResponsible(true)}
                  aria-label={isAdmin ? 'Клікніть для редагування' : undefined}
                >
                  {doc.responsible ? (
                    <span>{doc.responsible.full_name || doc.responsible.email}</span>
                  ) : (
                    <span className="not-assigned">Не призначено / Nie przypisano</span>
                  )}
                  {isAdmin && <span className="edit-icon" aria-hidden="true">Edit</span>}
                </div>
              )}
            </div>
          </div>

          <FileUpload document={doc} profile={profile} onUpdate={onUpdate} canEdit={canUpload} />
          <Comments document={doc} profile={profile} canComment={canComment} canView={canViewComments} />
        </div>
      </div>
    </div>
  )
}

// =====================================================
// ADD DOCUMENT MODAL
// =====================================================
function AddDocumentModal({ section, profile, onClose, onAdded }) {
  const [nameUk, setNameUk] = useState('')
  const [namePl, setNamePl] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const modalRef = useRef(null)
  const addToast = useToast()

  useFocusTrap(modalRef, true)

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.document.addEventListener('keydown', handleEscape)
    return () => window.document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)

    const { data, error } = await supabase.from('documents').insert({
      section_id: section.id,
      code: sanitizeText(code) || `${section.code}-X`,
      name_uk: sanitizeText(nameUk),
      name_pl: sanitizeText(namePl),
      status: 'pending',
      is_custom: true,
      order_index: 999
    }).select().single()

    if (!error && data) {
      await logAudit(profile.id, 'create_document', 'document', data.id, { name_uk: nameUk })
      addToast('Документ створено / Dokument utworzony', 'success')
      onAdded()
      onClose()
    } else {
      addToast('Помилка створення / Blad tworzenia', 'error')
    }
    setSubmitting(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="add-doc-title">
      <div ref={modalRef} className="modal add-document" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 id="add-doc-title">Додати документ / Dodaj dokument</h3>
          <button className="close-btn" onClick={onClose} aria-label="Закрити">X</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="doc-code">Код / Kod</label>
            <input id="doc-code" value={code} onChange={e => setCode(e.target.value)} placeholder={`${section.code}-X`} />
          </div>
          <div className="form-group">
            <label htmlFor="doc-name-uk">Назва (UA) / Nazwa (UA)</label>
            <input id="doc-name-uk" value={nameUk} onChange={e => setNameUk(e.target.value)} required />
          </div>
          <div className="form-group">
            <label htmlFor="doc-name-pl">Назва (PL) / Nazwa (PL)</label>
            <input id="doc-name-pl" value={namePl} onChange={e => setNamePl(e.target.value)} required />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Скасувати / Anuluj</button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? '...' : 'Додати / Dodaj'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// =====================================================
// USER MANAGEMENT COMPONENT
// =====================================================
function UserManagement({ currentUser, onClose }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [newUser, setNewUser] = useState({ email: '', password: '', full_name: '', role: 'user_cat1' })
  const [creating, setCreating] = useState(false)
  const modalRef = useRef(null)
  const addToast = useToast()

  useFocusTrap(modalRef, true)

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.document.addEventListener('keydown', handleEscape)
    return () => window.document.removeEventListener('keydown', handleEscape)
  }, [onClose])

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
      const { data, error } = await supabase.auth.signUp({
        email: newUser.email,
        password: newUser.password,
        options: {
          data: { full_name: newUser.full_name, role: newUser.role }
        }
      })
      if (error) throw error

      if (data.user) {
        await supabase.from('profiles').upsert({
          id: data.user.id,
          email: newUser.email,
          full_name: sanitizeText(newUser.full_name),
          role: newUser.role,
          is_active: true
        })
        await logAudit(currentUser.id, 'create_user', 'profile', data.user.id, { email: newUser.email, role: newUser.role })
      }

      setNewUser({ email: '', password: '', full_name: '', role: 'user_cat1' })
      loadUsers()
      addToast('Користувача створено! / Uzytkownik utworzony!', 'success')
    } catch (err) {
      addToast('Помилка: ' + err.message, 'error')
    }
    setCreating(false)
  }

  const updateUserRole = async (userId, newRole) => {
    if (!isValidUUID(userId)) return
    if (currentUser.role === 'lawyer_admin' && newRole === 'lawyer_auditor') {
      addToast('Тільки Super Admin може призначити Lawyer Auditor', 'error')
      return
    }
    await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    await logAudit(currentUser.id, 'update_user_role', 'profile', userId, { new_role: newRole })
    loadUsers()
    addToast('Роль оновлено / Rola zaktualizowana', 'success')
  }

  const toggleUserActive = async (userId, isActive) => {
    if (!isValidUUID(userId)) return
    await supabase.from('profiles').update({ is_active: !isActive }).eq('id', userId)
    await logAudit(currentUser.id, isActive ? 'deactivate_user' : 'activate_user', 'profile', userId)
    loadUsers()
    addToast(isActive ? 'Користувача деактивовано' : 'Користувача активовано', 'success')
  }

  if (loading) return <div className="loading" role="status">Завантаження... / Ladowanie...</div>

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="user-mgmt-title">
      <div ref={modalRef} className="modal user-management" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="user-mgmt-title">Користувачі / Uzytkownicy</h2>
          <button className="close-btn" onClick={onClose} aria-label="Закрити">X</button>
        </div>

        <div className="modal-body">
          <div className="add-user-form">
            <h4>Новий користувач / Nowy uzytkownik</h4>
            <form onSubmit={createUser}>
              <div className="form-row">
                <input
                  placeholder="Email"
                  type="email"
                  value={newUser.email}
                  onChange={e => setNewUser({...newUser, email: e.target.value})}
                  required
                  aria-label="Email"
                />
                <input
                  placeholder="Пароль / Haslo"
                  type="password"
                  value={newUser.password}
                  onChange={e => setNewUser({...newUser, password: e.target.value})}
                  required
                  minLength={6}
                  aria-label="Пароль"
                />
              </div>
              <div className="form-row">
                <input
                  placeholder="Імя / Imie"
                  value={newUser.full_name}
                  onChange={e => setNewUser({...newUser, full_name: e.target.value})}
                  required
                  aria-label="Ім'я"
                />
                <select
                  value={newUser.role}
                  onChange={e => setNewUser({...newUser, role: e.target.value})}
                  aria-label="Роль"
                >
                  {Object.entries(ROLES).map(([key, val]) => (
                    <option key={key} value={key}>{val.uk} / {val.pl}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn-primary" disabled={creating}>
                {creating ? '...' : 'Створити / Utworz'}
              </button>
            </form>
          </div>

          <h4>Список ({users.length})</h4>
          <div className="user-table-container" role="region" aria-label="Список користувачів">
            <table className="user-table">
              <thead>
                <tr>
                  <th scope="col">Ім'я / Imie</th>
                  <th scope="col">Email</th>
                  <th scope="col">Роль / Rola</th>
                  <th scope="col">Дії / Akcje</th>
                </tr>
              </thead>
              <tbody>
                {users.map(user => (
                  <tr key={user.id} className={user.is_active ? '' : 'inactive'}>
                    <td>{user.full_name || '—'}</td>
                    <td>{user.email}</td>
                    <td>
                      <select
                        value={user.role}
                        onChange={e => updateUserRole(user.id, e.target.value)}
                        disabled={user.id === currentUser.id}
                        className={`role-badge ${user.role}`}
                        aria-label={`Роль для ${user.email}`}
                      >
                        {Object.entries(ROLES).map(([key, val]) => (
                          <option key={key} value={key}>{val.uk}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      {user.id !== currentUser.id && (
                        <button
                          className={user.is_active ? 'btn-danger' : 'btn-success'}
                          onClick={() => toggleUserActive(user.id, user.is_active)}
                          aria-label={user.is_active ? `Деактивувати ${user.email}` : `Активувати ${user.email}`}
                        >
                          {user.is_active ? 'Lock' : 'Unlock'}
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
  const [filter, setFilter] = useState('')
  const debouncedFilter = useDebounce(filter, 300)
  const modalRef = useRef(null)

  useFocusTrap(modalRef, true)

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.document.addEventListener('keydown', handleEscape)
    return () => window.document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  useEffect(() => {
    loadLogs()
  }, [])

  const loadLogs = async () => {
    const { data } = await supabase
      .from('audit_log')
      .select('*, user:user_id(full_name, email)')
      .order('created_at', { ascending: false })
      .limit(200)
    setLogs(data || [])
    setLoading(false)
  }

  const actionLabels = {
    'upload_file': 'Завантаження файлу',
    'delete_file': 'Видалення файлу',
    'download_file': 'Скачування файлу',
    'view_file': 'Перегляд файлу',
    'view_document': 'Перегляд документа',
    'update_status': 'Зміна статусу',
    'update_responsible': 'Зміна відповідального',
    'add_comment': 'Додано коментар',
    'create_document': 'Створено документ',
    'create_user': 'Створено користувача',
    'update_user_role': 'Зміна ролі',
    'activate_user': 'Активація',
    'deactivate_user': 'Деактивація'
  }

  const filteredLogs = useMemo(() => {
    if (!debouncedFilter) return logs
    const lowerFilter = debouncedFilter.toLowerCase()
    return logs.filter(l =>
      l.action.toLowerCase().includes(lowerFilter) ||
      l.user?.email?.toLowerCase().includes(lowerFilter) ||
      l.user?.full_name?.toLowerCase().includes(lowerFilter)
    )
  }, [logs, debouncedFilter])

  return (
    <div className="modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-labelledby="audit-title">
      <div ref={modalRef} className="modal audit-log" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="audit-title">Журнал аудиту / Dziennik audytu</h2>
          <button className="close-btn" onClick={onClose} aria-label="Закрити">X</button>
        </div>

        <div className="modal-body">
          <label htmlFor="audit-filter" className="visually-hidden">Фільтр</label>
          <input
            id="audit-filter"
            type="text"
            placeholder="Фільтр... / Filtr..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="filter-input"
          />

          {loading ? (
            <div className="loading" role="status">Завантаження...</div>
          ) : (
            <div className="audit-list" role="log" aria-label="Записи журналу аудиту">
              {filteredLogs.map(log => (
                <article key={log.id} className="audit-item">
                  <div className="audit-header">
                    <span className="audit-action">{actionLabels[log.action] || log.action}</span>
                    <time className="audit-date" dateTime={log.created_at}>
                      {new Date(log.created_at).toLocaleString()}
                    </time>
                  </div>
                  <div className="audit-user">
                    {log.user?.full_name || log.user?.email || 'System'}
                  </div>
                  {log.details && (
                    <div className="audit-details">
                      {JSON.stringify(log.details)}
                    </div>
                  )}
                </article>
              ))}
              {filteredLogs.length === 0 && (
                <div className="no-logs">Немає записів / Brak wpisow</div>
              )}
            </div>
          )}
        </div>
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
  const [showUserManagement, setShowUserManagement] = useState(false)
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [showAddDocument, setShowAddDocument] = useState(false)
  const [newDocuments, setNewDocuments] = useState(new Set())
  const [newComments, setNewComments] = useState({})
  const addToast = useToast()

  // Initialize auth
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session) loadProfile(data.session.user.id)
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_, session) => {
      setSession(session)
      if (session) loadProfile(session.user.id)
      else {
        setProfile(null)
        setLoading(false)
      }
    })

    return () => subscription?.unsubscribe()
  }, [])

  const loadProfile = async (userId) => {
    if (!isValidUUID(userId)) {
      setLoading(false)
      return
    }
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).single()
    setProfile(data)
    loadCompanies()
  }

  const loadCompanies = async () => {
    const { data } = await supabase.from('companies').select('*').order('order_index')
    setCompanies(data || [])
    if (data && data.length > 0) {
      setSelectedCompany(data[0])
    }
    setLoading(false)
  }

  const loadSections = useCallback(async () => {
    if (!selectedCompany || !isValidUUID(selectedCompany.id)) return
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
  }, [selectedCompany])

  useEffect(() => {
    if (selectedCompany) loadSections()
  }, [selectedCompany, loadSections])

  const loadDocuments = useCallback(async () => {
    if (!activeSection || !isValidUUID(activeSection.id)) return

    const { data: subSections } = await supabase
      .from('document_sections')
      .select('id')
      .eq('parent_section_id', activeSection.id)

    const sectionIds = [activeSection.id, ...(subSections || []).map(s => s.id)]

    // SECURITY FIX: Using .in() with validated UUIDs
    const validSectionIds = sectionIds.filter(isValidUUID)

    const { data } = await supabase
      .from('documents')
      .select('*, responsible:profiles!documents_responsible_user_id_fkey(full_name, email)')
      .in('section_id', validSectionIds)
      .order('order_index')
    setDocuments(data || [])

    if (profile) {
      loadNewIndicators(data || [])
    }
  }, [activeSection, profile])

  useEffect(() => {
    if (activeSection) loadDocuments()
  }, [activeSection, loadDocuments])

  // SECURITY FIX: Load indicators using .in() instead of string interpolation
  const loadNewIndicators = async (docs) => {
    if (!profile || !isValidUUID(profile.id)) return

    const docIds = docs.map(d => d.id).filter(isValidUUID)
    if (docIds.length === 0) return

    // Get documents user hasn't viewed - using .in() for security
    const { data: views } = await supabase
      .from('document_views')
      .select('document_id')
      .eq('user_id', profile.id)
      .in('document_id', docIds)

    const viewedIds = new Set((views || []).map(v => v.document_id))
    const newDocs = new Set(docIds.filter(id => !viewedIds.has(id)))
    setNewDocuments(newDocs)

    // Get unread comments count per document - SECURE VERSION
    if (profile.role !== 'user_cat1') {
      // First get all comments for these documents
      const { data: allComments } = await supabase
        .from('comments')
        .select('id, document_id')
        .in('document_id', docIds)

      if (allComments && allComments.length > 0) {
        const commentIds = allComments.map(c => c.id)

        // Then get which ones user has read - using .in() for security
        const { data: readComments } = await supabase
          .from('comment_reads')
          .select('comment_id')
          .eq('user_id', profile.id)
          .in('comment_id', commentIds)  // SECURE: using .in() instead of SQL subquery

        const readIds = new Set((readComments || []).map(r => r.comment_id))

        const newCommentsMap = {}
        allComments.forEach(c => {
          if (!readIds.has(c.id)) {
            newCommentsMap[c.document_id] = (newCommentsMap[c.document_id] || 0) + 1
          }
        })
        setNewComments(newCommentsMap)
      } else {
        setNewComments({})
      }
    }
  }

  const updateStatus = async (docId, status) => {
    if (!isValidUUID(docId)) return
    await supabase.from('documents').update({
      status,
      updated_at: new Date().toISOString()
    }).eq('id', docId)
    await logAudit(profile.id, 'update_status', 'document', docId, { status })
    loadDocuments()
    addToast('Статус оновлено / Status zaktualizowany', 'success')
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    addToast('Ви вийшли з системи / Wylogowano', 'info')
  }

  if (loading) return <div className="loading" role="status" aria-live="polite">Завантаження... / Ladowanie...</div>
  if (!session) return <Auth />
  if (!profile) return <div className="loading" role="status">Завантаження профілю... / Ladowanie profilu...</div>

  const isAdmin = profile.role === 'super_admin' || profile.role === 'lawyer_admin'
  const isSuperAdmin = profile.role === 'super_admin'
  const totalDocs = documents.length
  const completedDocs = documents.filter(d => d.status === 'done').length
  const progress = totalDocs > 0 ? Math.round((completedDocs / totalDocs) * 100) : 0

  return (
    <div className="app">
      <a href="#main-content" className="skip-link">
        Перейти до контенту / Przejdz do tresci
      </a>

      <header role="banner">
        <h1>Audit System | {selectedCompany?.name_uk}</h1>
        <div className="header-controls">
          <div className="user-info">
            <span>{profile.full_name || profile.email}</span>
            <span className="role">{ROLES[profile.role]?.uk}</span>
          </div>

          {isSuperAdmin && (
            <>
              <button
                onClick={() => setShowUserManagement(true)}
                title="Користувачі"
                aria-label="Відкрити управління користувачами"
              >
                Users
              </button>
              <button
                onClick={() => setShowAuditLog(true)}
                title="Журнал аудиту"
                aria-label="Відкрити журнал аудиту"
              >
                Audit
              </button>
            </>
          )}

          <label htmlFor="company-select" className="visually-hidden">Вибрати компанію</label>
          <select
            id="company-select"
            value={selectedCompany?.id || ''}
            onChange={e => {
              const company = companies.find(c => c.id === e.target.value)
              setSelectedCompany(company)
            }}
            aria-label="Вибір компанії"
          >
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name_uk} / {c.name_pl}</option>
            ))}
          </select>

          <button onClick={handleSignOut} aria-label="Вийти з системи">
            Вийти
          </button>
        </div>
      </header>

      <div className="progress-bar" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100">
        <div className="progress-track">
          <div className="progress" style={{ width: progress + '%' }}></div>
        </div>
        <span>{completedDocs} / {totalDocs} документів ({progress}%)</span>
      </div>

      <nav className="sections" role="tablist" aria-label="Розділи документів">
        {sections.map(s => (
          <button
            key={s.id}
            className={activeSection?.id === s.id ? 'active' : ''}
            onClick={() => setActiveSection(s)}
            role="tab"
            aria-selected={activeSection?.id === s.id}
            aria-controls="documents-panel"
          >
            {s.code}. {s.name_uk?.substring(0, 20)}
          </button>
        ))}
      </nav>

      <main id="main-content" role="main">
        <div className="section-header">
          <h2>
            <span className="section-code">{activeSection?.code}.</span>
            {activeSection?.name_uk} / {activeSection?.name_pl}
          </h2>
          {isAdmin && (
            <button className="btn-primary" onClick={() => setShowAddDocument(true)}>
              Додати документ
            </button>
          )}
        </div>

        <div
          id="documents-panel"
          className="documents"
          role="list"
          aria-label="Список документів"
        >
          {documents.map(doc => {
            const hasNew = newDocuments.has(doc.id)
            const unreadCommentsCount = newComments[doc.id] || 0

            return (
              <div
                key={doc.id}
                className={`doc-item ${doc.status || 'pending'} ${hasNew ? 'new' : ''}`}
                onClick={() => setSelectedDocument(doc)}
                role="listitem"
                tabIndex={0}
                onKeyDown={e => e.key === 'Enter' && setSelectedDocument(doc)}
                aria-label={`${doc.code} ${doc.name_uk}${hasNew ? ', новий' : ''}${unreadCommentsCount > 0 ? `, ${unreadCommentsCount} нових коментарів` : ''}`}
              >
                {hasNew && <span className="new-badge" aria-hidden="true">NEW</span>}
                {unreadCommentsCount > 0 && (
                  <span className="comments-badge" title={`${unreadCommentsCount} нових коментарів`} aria-hidden="true">
                    {unreadCommentsCount}
                  </span>
                )}

                <div className="doc-info">
                  <span className="doc-code">{doc.code}</span>
                  <div className="doc-names">
                    <span className="doc-name">{doc.name_uk}</span>
                    <span className="doc-name-pl">{doc.name_pl}</span>
                  </div>
                </div>

                {doc.responsible && (
                  <span className="doc-responsible">
                    {doc.responsible.full_name || doc.responsible.email}
                  </span>
                )}

                <select
                  value={doc.status || 'pending'}
                  onChange={e => { e.stopPropagation(); updateStatus(doc.id, e.target.value) }}
                  onClick={e => e.stopPropagation()}
                  disabled={!isAdmin}
                  aria-label={`Статус документа ${doc.code}`}
                >
                  {STATUS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.uk}</option>
                  ))}
                </select>
              </div>
            )
          })}

          {documents.length === 0 && (
            <div className="no-docs" role="status">
              Немає документів в цьому розділі / Brak dokumentow w tej sekcji
            </div>
          )}
        </div>
      </main>

      {showUserManagement && (
        <UserManagement currentUser={profile} onClose={() => setShowUserManagement(false)} />
      )}

      {showAuditLog && (
        <AuditLog onClose={() => setShowAuditLog(false)} />
      )}

      {selectedDocument && (
        <DocumentDetail
          document={selectedDocument}
          profile={profile}
          onClose={() => setSelectedDocument(null)}
          onUpdate={loadDocuments}
        />
      )}

      {showAddDocument && activeSection && (
        <AddDocumentModal
          section={activeSection}
          profile={profile}
          onClose={() => setShowAddDocument(false)}
          onAdded={loadDocuments}
        />
      )}
    </div>
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
