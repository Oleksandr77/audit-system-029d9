import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50MB
const MAX_FILES_PER_DOC = 10
const MAX_COMMENT_LENGTH = 250

// Toast notification component
function Toast({ message, type = 'info', onClose }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3000)
    return () => clearTimeout(timer)
  }, [onClose])

  const bgColor = {
    success: '#4CAF50',
    error: '#F44336',
    warning: '#FF9800',
    info: '#2196F3'
  }[type]

  return (
    <div style={{
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      background: bgColor,
      color: 'white',
      padding: '12px 24px',
      borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
      zIndex: 9999,
      animation: 'slideIn 0.3s ease'
    }}>
      {message}
    </div>
  )
}

// Toast hook for notifications
function useToast() {
  const [toast, setToast] = useState(null)

  const showToast = useCallback((message, type = 'info') => {
    setToast({ message, type })
  }, [])

  const hideToast = useCallback(() => {
    setToast(null)
  }, [])

  const ToastComponent = toast ? (
    <Toast message={toast.message} type={toast.type} onClose={hideToast} />
  ) : null

  return { showToast, ToastComponent }
}

// Auth Component with improved error handling
function Auth() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e) => {
    e.preventDefault()

    // Input validation
    if (!email.trim() || !password.trim()) {
      setError('Заповніть всі поля / Wypełnij wszystkie pola')
      return
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Невірний формат email / Nieprawidłowy format email')
      return
    }

    setLoading(true)
    setError('')

    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password
      })
      if (authError) throw authError
    } catch (err) {
      console.error('Auth error:', err)
      setError(err.message === 'Invalid login credentials'
        ? 'Невірний email або пароль / Nieprawidłowy email lub hasło'
        : err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="auth-container">
      <div className="auth-box">
        <h1>🔐 Audit System</h1>
        <p>Система управління документами<br/>System zarządzania dokumentami</p>
        <form onSubmit={handleSubmit}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
          <input
            type="password"
            placeholder="Пароль / Hasło"
            value={password}
            onChange={e => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            minLength={6}
          />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>
            {loading ? '⏳ Вхід...' : 'Увійти / Zaloguj'}
          </button>
        </form>
      </div>
    </div>
  )
}

// File Upload Component with improved error handling
function FileUpload({ document, profile, onUpdate, canEdit, showToast }) {
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef(null)
  const abortControllerRef = useRef(null)

  const loadFiles = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('document_files')
        .select('*')
        .eq('document_id', document.id)
        .order('created_at')

      if (error) throw error
      setFiles(data || [])
    } catch (err) {
      console.error('Error loading files:', err)
      showToast?.('Помилка завантаження файлів', 'error')
    }
  }, [document.id, showToast])

  useEffect(() => {
    loadFiles()
    return () => {
      // Cleanup: abort any pending uploads
      abortControllerRef.current?.abort()
    }
  }, [loadFiles])

  const handleUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files)
    if (!selectedFiles.length) return

    if (files.length + selectedFiles.length > MAX_FILES_PER_DOC) {
      showToast?.(`Максимум ${MAX_FILES_PER_DOC} файлів`, 'warning')
      return
    }

    setUploading(true)
    setUploadProgress(0)
    abortControllerRef.current = new AbortController()

    let uploadedCount = 0

    for (const file of selectedFiles) {
      // Validation
      if (file.size > MAX_FILE_SIZE) {
        showToast?.(`Файл ${file.name} перевищує 50MB`, 'warning')
        continue
      }

      if (!file.type.includes('pdf')) {
        showToast?.('Дозволені тільки PDF файли', 'warning')
        continue
      }

      try {
        const fileName = `${document.id}/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`

        const { error: uploadError } = await supabase.storage
          .from('documents')
          .upload(fileName, file)

        if (uploadError) throw uploadError

        const { error: dbError } = await supabase.from('document_files').insert({
          document_id: document.id,
          file_name: file.name,
          file_path: fileName,
          file_size: file.size,
          uploaded_by: profile.id
        })

        if (dbError) throw dbError

        await logAudit(profile.id, 'upload_file', 'document_file', document.id, { file_name: file.name })
        uploadedCount++
        setUploadProgress(Math.round((uploadedCount / selectedFiles.length) * 100))

      } catch (err) {
        console.error('Upload error:', err)
        showToast?.(`Помилка завантаження ${file.name}`, 'error')
      }
    }

    setUploading(false)
    setUploadProgress(0)

    if (uploadedCount > 0) {
      showToast?.(`Завантажено ${uploadedCount} файл(ів)`, 'success')
      loadFiles()
      onUpdate()
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (fileId, filePath) => {
    if (!confirm('Видалити файл? / Usunąć plik?')) return

    try {
      const { error: storageError } = await supabase.storage.from('documents').remove([filePath])
      if (storageError) console.warn('Storage delete warning:', storageError)

      const { error: dbError } = await supabase.from('document_files').delete().eq('id', fileId)
      if (dbError) throw dbError

      await logAudit(profile.id, 'delete_file', 'document_file', fileId, { file_path: filePath })
      showToast?.('Файл видалено', 'success')
      loadFiles()
      onUpdate()
    } catch (err) {
      console.error('Delete error:', err)
      showToast?.('Помилка видалення файлу', 'error')
    }
  }

  const handleDownload = useCallback(async (filePath, fileName) => {
    try {
      const { data, error } = await supabase.storage.from('documents').download(filePath)
      if (error) throw error

      if (data) {
        const url = URL.createObjectURL(data)
        const a = window.document.createElement('a')
        a.href = url
        a.download = fileName
        a.click()
        URL.revokeObjectURL(url)
        await logAudit(profile.id, 'download_file', 'document_file', document.id, { file_name: fileName })
      }
    } catch (err) {
      console.error('Download error:', err)
      showToast?.('Помилка завантаження файлу', 'error')
    }
  }, [document.id, profile.id, showToast])

  const handlePreview = useCallback(async (filePath) => {
    try {
      const { data, error } = await supabase.storage.from('documents').createSignedUrl(filePath, 3600)
      if (error) throw error

      if (data?.signedUrl) {
        window.open(data.signedUrl, '_blank')
        await logAudit(profile.id, 'view_file', 'document_file', document.id, { file_path: filePath })
      }
    } catch (err) {
      console.error('Preview error:', err)
      showToast?.('Помилка відкриття файлу', 'error')
    }
  }, [document.id, profile.id, showToast])

  return (
    <div className="file-upload">
      <div className="files-header">
        <span>📎 Файли / Pliki ({files.length}/{MAX_FILES_PER_DOC})</span>
        {canEdit && files.length < MAX_FILES_PER_DOC && (
          <label className="upload-btn">
            {uploading ? `${uploadProgress}%` : '➕'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              onChange={handleUpload}
              disabled={uploading}
              style={{ display: 'none' }}
            />
          </label>
        )}
      </div>
      <div className="files-list">
        {files.map(file => (
          <div key={file.id} className="file-item">
            <span className="file-icon">📄</span>
            <span className="file-name" title={file.file_name}>{file.file_name}</span>
            <span className="file-size">{(file.file_size / 1024 / 1024).toFixed(1)}MB</span>
            <div className="file-actions">
              <button onClick={() => handlePreview(file.file_path)} title="Переглянути / Podgląd">👁️</button>
              <button onClick={() => handleDownload(file.file_path, file.file_name)} title="Завантажити / Pobierz">⬇️</button>
              {canEdit && <button onClick={() => handleDelete(file.id, file.file_path)} title="Видалити / Usuń">🗑️</button>}
            </div>
          </div>
        ))}
        {files.length === 0 && <div className="no-files">Немає файлів / Brak plików</div>}
      </div>
    </div>
  )
}

// Comments Component with optimized queries
function Comments({ document, profile, canComment, canView, showToast }) {
  const [comments, setComments] = useState([])
  const [newComment, setNewComment] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [unreadComments, setUnreadComments] = useState(new Set())
  const [loading, setLoading] = useState(true)

  const loadComments = useCallback(async () => {
    if (!canView) return

    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('comments')
        .select('*, author:author_id(full_name, email)')
        .eq('document_id', document.id)
        .order('created_at')

      if (error) throw error
      setComments(data || [])
    } catch (err) {
      console.error('Error loading comments:', err)
      showToast?.('Помилка завантаження коментарів', 'error')
    } finally {
      setLoading(false)
    }
  }, [document.id, canView, showToast])

  const loadUnreadComments = useCallback(async () => {
    if (!canView || !profile?.id) return

    try {
      // Single optimized query instead of N+1
      const { data: readComments, error } = await supabase
        .from('comment_reads')
        .select('comment_id')
        .eq('user_id', profile.id)

      if (error) throw error

      const readIds = new Set((readComments || []).map(r => r.comment_id))

      const { data: allComments, error: commentsError } = await supabase
        .from('comments')
        .select('id')
        .eq('document_id', document.id)

      if (commentsError) throw commentsError

      const unread = new Set()
      ;(allComments || []).forEach(c => {
        if (!readIds.has(c.id)) unread.add(c.id)
      })
      setUnreadComments(unread)
    } catch (err) {
      console.error('Error loading unread comments:', err)
    }
  }, [document.id, profile?.id, canView])

  useEffect(() => {
    loadComments()
    loadUnreadComments()
  }, [loadComments, loadUnreadComments])

  const markAsRead = useCallback(async (commentId) => {
    if (!unreadComments.has(commentId)) return

    try {
      await supabase.from('comment_reads').upsert({
        comment_id: commentId,
        user_id: profile.id
      }, { onConflict: 'comment_id,user_id' })

      setUnreadComments(prev => {
        const next = new Set(prev)
        next.delete(commentId)
        return next
      })
    } catch (err) {
      console.error('Error marking as read:', err)
    }
  }, [unreadComments, profile?.id])

  const handleSubmit = async (e) => {
    e.preventDefault()
    const trimmedComment = newComment.trim()

    if (!trimmedComment || trimmedComment.length > MAX_COMMENT_LENGTH) {
      showToast?.('Коментар порожній або занадто довгий', 'warning')
      return
    }

    setSubmitting(true)

    try {
      const { data, error } = await supabase.from('comments').insert({
        document_id: document.id,
        author_id: profile.id,
        content: trimmedComment,
        parent_comment_id: replyTo
      }).select().single()

      if (error) throw error

      await logAudit(profile.id, 'add_comment', 'comment', data.id, { document_id: document.id })
      setNewComment('')
      setReplyTo(null)
      showToast?.('Коментар додано', 'success')
      loadComments()
    } catch (err) {
      console.error('Error adding comment:', err)
      showToast?.('Помилка додавання коментаря', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const topLevelComments = useMemo(() =>
    comments.filter(c => !c.parent_comment_id),
    [comments]
  )

  const getReplies = useCallback((parentId) =>
    comments.filter(c => c.parent_comment_id === parentId),
    [comments]
  )

  if (!canView) return null

  const renderComment = (comment, isReply = false) => (
    <div
      key={comment.id}
      className={`comment ${isReply ? 'reply' : ''} ${unreadComments.has(comment.id) ? 'unread' : ''}`}
      onClick={() => markAsRead(comment.id)}
    >
      {unreadComments.has(comment.id) && <span className="new-badge">NEW</span>}
      <div className="comment-header">
        <span className="comment-author">👤 {comment.author?.full_name || comment.author?.email}</span>
        <span className="comment-date">{new Date(comment.created_at).toLocaleString()}</span>
      </div>
      <p className="comment-content">{comment.content}</p>
      {canComment && !isReply && (
        <button className="reply-btn" onClick={(e) => { e.stopPropagation(); setReplyTo(comment.id) }}>
          ↩️ Відповісти / Odpowiedz
        </button>
      )}
      {getReplies(comment.id).map(reply => renderComment(reply, true))}
    </div>
  )

  return (
    <div className="comments-section">
      <h4>💬 Коментарі / Komentarze ({comments.length})</h4>

      {canComment && (
        <form onSubmit={handleSubmit} className="comment-form">
          {replyTo && (
            <div className="replying-to">
              Відповідь на коментар / Odpowiedź na komentarz
              <button type="button" onClick={() => setReplyTo(null)}>✕</button>
            </div>
          )}
          <textarea
            value={newComment}
            onChange={e => setNewComment(e.target.value)}
            placeholder="Напишіть коментар... / Napisz komentarz..."
            maxLength={MAX_COMMENT_LENGTH}
          />
          <div className="comment-footer">
            <span className="char-count">{newComment.length}/{MAX_COMMENT_LENGTH}</span>
            <button type="submit" disabled={submitting || !newComment.trim()}>
              {submitting ? '⏳...' : '📤 Надіслати / Wyślij'}
            </button>
          </div>
        </form>
      )}

      <div className="comments-list">
        {loading ? (
          <div className="loading-small">Завантаження...</div>
        ) : (
          <>
            {topLevelComments.map(comment => renderComment(comment))}
            {comments.length === 0 && <div className="no-comments">Немає коментарів / Brak komentarzy</div>}
          </>
        )}
      </div>
    </div>
  )
}

// Document Detail Modal with improved UX
function DocumentDetail({ document, profile, onClose, onUpdate, showToast }) {
  const [doc, setDoc] = useState(document)
  const [users, setUsers] = useState([])
  const [editingResponsible, setEditingResponsible] = useState(false)
  const [saving, setSaving] = useState(false)

  const isAdmin = profile.role === 'super_admin' || profile.role === 'lawyer_admin'
  const isUserCat1 = profile.role === 'user_cat1'
  const canUpload = isAdmin || isUserCat1
  const canComment = !isUserCat1
  const canViewComments = !isUserCat1

  useEffect(() => {
    let isMounted = true

    const loadUsers = async () => {
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .eq('is_active', true)

        if (error) throw error
        if (isMounted) setUsers(data || [])
      } catch (err) {
        console.error('Error loading users:', err)
      }
    }

    const recordView = async () => {
      try {
        await supabase.from('document_views').upsert({
          document_id: document.id,
          user_id: profile.id,
          viewed_at: new Date().toISOString()
        }, { onConflict: 'document_id,user_id' })
        await logAudit(profile.id, 'view_document', 'document', document.id)
      } catch (err) {
        console.error('Error recording view:', err)
      }
    }

    loadUsers()
    recordView()

    return () => { isMounted = false }
  }, [document.id, profile.id])

  const updateResponsible = useCallback(async (userId) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('documents').update({
        responsible_user_id: userId || null,
        updated_at: new Date().toISOString()
      }).eq('id', doc.id)

      if (error) throw error

      await logAudit(profile.id, 'update_responsible', 'document', doc.id, { responsible_user_id: userId })

      const user = users.find(u => u.id === userId)
      setDoc(prev => ({ ...prev, responsible_user_id: userId, responsible: user }))
      setEditingResponsible(false)
      showToast?.('Відповідального змінено', 'success')
      onUpdate()
    } catch (err) {
      console.error('Error updating responsible:', err)
      showToast?.('Помилка зміни відповідального', 'error')
    } finally {
      setSaving(false)
    }
  }, [doc.id, users, profile.id, onUpdate, showToast])

  const updateStatus = useCallback(async (status) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('documents').update({
        status,
        updated_at: new Date().toISOString()
      }).eq('id', doc.id)

      if (error) throw error

      await logAudit(profile.id, 'update_status', 'document', doc.id, { status })
      setDoc(prev => ({ ...prev, status }))
      showToast?.('Статус змінено', 'success')
      onUpdate()
    } catch (err) {
      console.error('Error updating status:', err)
      showToast?.('Помилка зміни статусу', 'error')
    } finally {
      setSaving(false)
    }
  }, [doc.id, profile.id, onUpdate, showToast])

  // Close on Escape key
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal document-detail" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="doc-code">{doc.code}</span>
            <h3>{doc.name_uk}</h3>
            <p className="doc-name-pl">{doc.name_pl}</p>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Закрити">✕</button>
        </div>

        <div className="modal-body">
          <div className="doc-info-row">
            <div className="info-item">
              <label>Статус / Status</label>
              <select
                value={doc.status || 'pending'}
                onChange={e => updateStatus(e.target.value)}
                disabled={!isAdmin || saving}
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
                  disabled={saving}
                  autoFocus
                >
                  <option value="">— Не призначено / Nie przypisano —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                  ))}
                </select>
              ) : (
                <div
                  className="responsible-display"
                  onClick={() => isAdmin && !saving && setEditingResponsible(true)}
                  style={{ cursor: isAdmin ? 'pointer' : 'default' }}
                >
                  {doc.responsible ? (
                    <span>👤 {doc.responsible.full_name || doc.responsible.email}</span>
                  ) : (
                    <span className="not-assigned">Не призначено / Nie przypisano</span>
                  )}
                  {isAdmin && <span className="edit-icon">✏️</span>}
                </div>
              )}
            </div>
          </div>

          <FileUpload
            document={doc}
            profile={profile}
            onUpdate={onUpdate}
            canEdit={canUpload}
            showToast={showToast}
          />

          <Comments
            document={doc}
            profile={profile}
            canComment={canComment}
            canView={canViewComments}
            showToast={showToast}
          />
        </div>
      </div>
    </div>
  )
}

// Add Document Modal with validation
function AddDocumentModal({ section, profile, onClose, onAdded, showToast }) {
  const [nameUk, setNameUk] = useState('')
  const [namePl, setNamePl] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState({})

  const validate = () => {
    const newErrors = {}
    if (!nameUk.trim()) newErrors.nameUk = 'Обов\'язкове поле'
    if (!namePl.trim()) newErrors.namePl = 'Обов\'язкове поле'
    if (nameUk.length > 200) newErrors.nameUk = 'Максимум 200 символів'
    if (namePl.length > 200) newErrors.namePl = 'Максимум 200 символів'
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!validate()) return

    setSubmitting(true)

    try {
      const { data, error } = await supabase.from('documents').insert({
        section_id: section.id,
        code: code.trim() || `${section.code}-NEW`,
        name_uk: nameUk.trim(),
        name_pl: namePl.trim(),
        status: 'pending',
        is_custom: true,
        order_index: 999
      }).select().single()

      if (error) throw error

      await logAudit(profile.id, 'create_document', 'document', data.id, { name_uk: nameUk.trim() })
      showToast?.('Документ створено', 'success')
      onAdded()
      onClose()
    } catch (err) {
      console.error('Error creating document:', err)
      showToast?.('Помилка створення документа', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal add-document" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3>➕ Додати документ / Dodaj dokument</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Код / Kod (опціонально)</label>
            <input
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder={`${section.code}-NEW`}
              maxLength={20}
            />
          </div>
          <div className="form-group">
            <label>Назва (UA) / Nazwa (UA) *</label>
            <input
              value={nameUk}
              onChange={e => setNameUk(e.target.value)}
              required
              maxLength={200}
              className={errors.nameUk ? 'input-error' : ''}
            />
            {errors.nameUk && <span className="field-error">{errors.nameUk}</span>}
          </div>
          <div className="form-group">
            <label>Назва (PL) / Nazwa (PL) *</label>
            <input
              value={namePl}
              onChange={e => setNamePl(e.target.value)}
              required
              maxLength={200}
              className={errors.namePl ? 'input-error' : ''}
            />
            {errors.namePl && <span className="field-error">{errors.namePl}</span>}
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={submitting}>
              Скасувати / Anuluj
            </button>
            <button type="submit" className="btn-primary" disabled={submitting}>
              {submitting ? '⏳ Створення...' : 'Додати / Dodaj'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// User Management Component with improved security
function UserManagement({ currentUser, onClose, showToast }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [newUser, setNewUser] = useState({ email: '', password: '', full_name: '', role: 'user_cat1' })
  const [creating, setCreating] = useState(false)
  const [errors, setErrors] = useState({})

  useEffect(() => {
    loadUsers()
  }, [])

  const loadUsers = async () => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) throw error
      setUsers(data || [])
    } catch (err) {
      console.error('Error loading users:', err)
      showToast?.('Помилка завантаження користувачів', 'error')
    } finally {
      setLoading(false)
    }
  }

  const validateNewUser = () => {
    const newErrors = {}
    if (!newUser.email.trim()) newErrors.email = 'Обов\'язкове поле'
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newUser.email)) newErrors.email = 'Невірний email'
    if (!newUser.password || newUser.password.length < 6) newErrors.password = 'Мінімум 6 символів'
    if (!newUser.full_name.trim()) newErrors.full_name = 'Обов\'язкове поле'
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const createUser = async (e) => {
    e.preventDefault()
    if (!validateNewUser()) return

    setCreating(true)
    try {
      const { data, error } = await supabase.auth.signUp({
        email: newUser.email.trim().toLowerCase(),
        password: newUser.password,
        options: {
          data: { full_name: newUser.full_name.trim(), role: newUser.role }
        }
      })

      if (error) throw error

      if (data.user) {
        const { error: profileError } = await supabase.from('profiles').upsert({
          id: data.user.id,
          email: newUser.email.trim().toLowerCase(),
          full_name: newUser.full_name.trim(),
          role: newUser.role,
          is_active: true
        })

        if (profileError) throw profileError

        await logAudit(currentUser.id, 'create_user', 'profile', data.user.id, {
          email: newUser.email,
          role: newUser.role
        })
      }

      setNewUser({ email: '', password: '', full_name: '', role: 'user_cat1' })
      setErrors({})
      loadUsers()
      showToast?.('Користувача створено!', 'success')
    } catch (err) {
      console.error('Error creating user:', err)
      showToast?.(`Помилка: ${err.message}`, 'error')
    } finally {
      setCreating(false)
    }
  }

  const updateUserRole = async (userId, newRole) => {
    // Security check
    if (currentUser.role === 'lawyer_admin' && (newRole === 'lawyer_auditor' || newRole === 'super_admin')) {
      showToast?.('Недостатньо прав для цієї дії', 'warning')
      return
    }

    try {
      const { error } = await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
      if (error) throw error

      await logAudit(currentUser.id, 'update_user_role', 'profile', userId, { new_role: newRole })
      showToast?.('Роль змінено', 'success')
      loadUsers()
    } catch (err) {
      console.error('Error updating role:', err)
      showToast?.('Помилка зміни ролі', 'error')
    }
  }

  const toggleUserActive = async (userId, isActive) => {
    try {
      const { error } = await supabase.from('profiles').update({ is_active: !isActive }).eq('id', userId)
      if (error) throw error

      await logAudit(currentUser.id, isActive ? 'deactivate_user' : 'activate_user', 'profile', userId)
      showToast?.(isActive ? 'Користувача деактивовано' : 'Користувача активовано', 'success')
      loadUsers()
    } catch (err) {
      console.error('Error toggling user:', err)
      showToast?.('Помилка зміни статусу', 'error')
    }
  }

  if (loading) return <div className="loading">Завантаження... / Ładowanie...</div>

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal user-management" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>👥 Користувачі / Użytkownicy</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="add-user-form">
            <h4>➕ Новий користувач / Nowy użytkownik</h4>
            <form onSubmit={createUser}>
              <div className="form-row">
                <div className="form-field">
                  <input
                    placeholder="Email"
                    type="email"
                    value={newUser.email}
                    onChange={e => setNewUser({...newUser, email: e.target.value})}
                    required
                    className={errors.email ? 'input-error' : ''}
                  />
                  {errors.email && <span className="field-error">{errors.email}</span>}
                </div>
                <div className="form-field">
                  <input
                    placeholder="Пароль / Hasło"
                    type="password"
                    value={newUser.password}
                    onChange={e => setNewUser({...newUser, password: e.target.value})}
                    required
                    minLength={6}
                    className={errors.password ? 'input-error' : ''}
                  />
                  {errors.password && <span className="field-error">{errors.password}</span>}
                </div>
              </div>
              <div className="form-row">
                <div className="form-field">
                  <input
                    placeholder="Ім'я / Imię"
                    value={newUser.full_name}
                    onChange={e => setNewUser({...newUser, full_name: e.target.value})}
                    required
                    className={errors.full_name ? 'input-error' : ''}
                  />
                  {errors.full_name && <span className="field-error">{errors.full_name}</span>}
                </div>
                <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})}>
                  {Object.entries(ROLES).map(([key, val]) => (
                    <option key={key} value={key}>{val.uk} / {val.pl}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn-primary" disabled={creating}>
                {creating ? '⏳ Створення...' : '➕ Створити / Utwórz'}
              </button>
            </form>
          </div>

          <h4>📋 Список ({users.length})</h4>
          <table className="user-table">
            <thead>
              <tr>
                <th>Ім'я / Imię</th>
                <th>Email</th>
                <th>Роль / Rola</th>
                <th>Дії / Akcje</th>
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
                        title={user.is_active ? 'Деактивувати' : 'Активувати'}
                      >
                        {user.is_active ? '🔒' : '🔓'}
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
  )
}

// Audit Log Component with pagination
function AuditLog({ onClose }) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(true)
  const LIMIT = 50

  useEffect(() => {
    loadLogs()
  }, [page])

  const loadLogs = async () => {
    try {
      setLoading(true)
      const { data, error } = await supabase
        .from('audit_log')
        .select('*, user:user_id(full_name, email)')
        .order('created_at', { ascending: false })
        .range(page * LIMIT, (page + 1) * LIMIT - 1)

      if (error) throw error

      if (page === 0) {
        setLogs(data || [])
      } else {
        setLogs(prev => [...prev, ...(data || [])])
      }
      setHasMore((data || []).length === LIMIT)
    } catch (err) {
      console.error('Error loading logs:', err)
    } finally {
      setLoading(false)
    }
  }

  const actionLabels = {
    'upload_file': '📤 Завантаження файлу',
    'delete_file': '🗑️ Видалення файлу',
    'download_file': '⬇️ Скачування файлу',
    'view_file': '👁️ Перегляд файлу',
    'view_document': '👁️ Перегляд документа',
    'update_status': '🔄 Зміна статусу',
    'update_responsible': '👤 Зміна відповідального',
    'add_comment': '💬 Додано коментар',
    'create_document': '📄 Створено документ',
    'create_user': '👤 Створено користувача',
    'update_user_role': '🔧 Зміна ролі',
    'activate_user': '🔓 Активація',
    'deactivate_user': '🔒 Деактивація'
  }

  const filteredLogs = useMemo(() => {
    if (!filter.trim()) return logs
    const lowerFilter = filter.toLowerCase()
    return logs.filter(l =>
      l.action.toLowerCase().includes(lowerFilter) ||
      l.user?.email?.toLowerCase().includes(lowerFilter) ||
      l.user?.full_name?.toLowerCase().includes(lowerFilter)
    )
  }, [logs, filter])

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal audit-log" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📜 Журнал аудиту / Dziennik audytu</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <input
            type="text"
            placeholder="Фільтр... / Filtr..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="filter-input"
          />

          {loading && page === 0 ? (
            <div className="loading">Завантаження...</div>
          ) : (
            <div className="audit-list">
              {filteredLogs.map(log => (
                <div key={log.id} className="audit-item">
                  <div className="audit-header">
                    <span className="audit-action">{actionLabels[log.action] || log.action}</span>
                    <span className="audit-date">{new Date(log.created_at).toLocaleString()}</span>
                  </div>
                  <div className="audit-user">
                    👤 {log.user?.full_name || log.user?.email || 'System'}
                  </div>
                  {log.details && (
                    <div className="audit-details">
                      {JSON.stringify(log.details, null, 2)}
                    </div>
                  )}
                </div>
              ))}
              {hasMore && !filter && (
                <button
                  className="btn-secondary load-more"
                  onClick={() => setPage(p => p + 1)}
                  disabled={loading}
                >
                  {loading ? '⏳...' : 'Завантажити більше'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Utility function for audit logging
async function logAudit(userId, action, entityType, entityId, details = null) {
  try {
    await supabase.from('audit_log').insert({
      user_id: userId,
      action,
      entity_type: entityType,
      entity_id: entityId,
      details
    })
  } catch (err) {
    console.error('Audit log error:', err)
  }
}

// Main App Component with all fixes
export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
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

  const { showToast, ToastComponent } = useToast()

  // Initialize auth with proper cleanup
  useEffect(() => {
    let isMounted = true

    const initAuth = async () => {
      try {
        const { data: { session: currentSession }, error: sessionError } = await supabase.auth.getSession()
        if (sessionError) throw sessionError

        if (isMounted) {
          setSession(currentSession)
          if (currentSession) {
            await loadProfile(currentSession.user.id)
          } else {
            setLoading(false)
          }
        }
      } catch (err) {
        console.error('Auth init error:', err)
        if (isMounted) {
          setError('Помилка ініціалізації')
          setLoading(false)
        }
      }
    }

    initAuth()

    // Subscribe to auth changes with cleanup
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (isMounted) {
        setSession(newSession)
        if (newSession) {
          await loadProfile(newSession.user.id)
        } else {
          setProfile(null)
          setLoading(false)
        }
      }
    })

    return () => {
      isMounted = false
      subscription?.unsubscribe()
    }
  }, [])

  const loadProfile = useCallback(async (userId) => {
    try {
      const { data, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single()

      if (profileError) throw profileError

      setProfile(data)
      await loadCompanies()
    } catch (err) {
      console.error('Profile load error:', err)
      setError('Помилка завантаження профілю')
      setLoading(false)
    }
  }, [])

  const loadCompanies = useCallback(async () => {
    try {
      const { data, error: companiesError } = await supabase
        .from('companies')
        .select('*')
        .order('order_index')

      if (companiesError) throw companiesError

      setCompanies(data || [])
      if (data && data.length > 0) {
        setSelectedCompany(data[0])
      }
    } catch (err) {
      console.error('Companies load error:', err)
      showToast('Помилка завантаження компаній', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  const loadSections = useCallback(async () => {
    if (!selectedCompany) return

    try {
      const { data, error: sectionsError } = await supabase
        .from('document_sections')
        .select('*')
        .eq('company_id', selectedCompany.id)
        .is('parent_section_id', null)
        .order('order_index')

      if (sectionsError) throw sectionsError

      setSections(data || [])
      if (data && data.length > 0) {
        setActiveSection(data[0])
      }
    } catch (err) {
      console.error('Sections load error:', err)
      showToast('Помилка завантаження розділів', 'error')
    }
  }, [selectedCompany, showToast])

  useEffect(() => {
    loadSections()
  }, [loadSections])

  const loadDocuments = useCallback(async () => {
    if (!activeSection) return

    try {
      const { data: subSections } = await supabase
        .from('document_sections')
        .select('id')
        .eq('parent_section_id', activeSection.id)

      const sectionIds = [activeSection.id, ...(subSections || []).map(s => s.id)]

      const { data, error: docsError } = await supabase
        .from('documents')
        .select('*, responsible:profiles!documents_responsible_user_id_fkey(full_name, email)')
        .in('section_id', sectionIds)
        .order('order_index')

      if (docsError) throw docsError

      setDocuments(data || [])

      // Load new documents indicator
      if (profile) {
        await loadNewIndicators(data || [])
      }
    } catch (err) {
      console.error('Documents load error:', err)
      showToast('Помилка завантаження документів', 'error')
    }
  }, [activeSection, profile, showToast])

  useEffect(() => {
    loadDocuments()
  }, [loadDocuments])

  const loadNewIndicators = useCallback(async (docs) => {
    if (!profile?.id || docs.length === 0) return

    const docIds = docs.map(d => d.id)

    try {
      // Optimized: single query for views
      const { data: views } = await supabase
        .from('document_views')
        .select('document_id')
        .eq('user_id', profile.id)
        .in('document_id', docIds)

      const viewedIds = new Set((views || []).map(v => v.document_id))
      const newDocs = new Set()
      docs.forEach(d => {
        if (!viewedIds.has(d.id)) newDocs.add(d.id)
      })
      setNewDocuments(newDocs)

      // Optimized: batch query for unread comments
      if (profile.role !== 'user_cat1') {
        const { data: readComments } = await supabase
          .from('comment_reads')
          .select('comment_id')
          .eq('user_id', profile.id)

        const readIds = new Set((readComments || []).map(r => r.comment_id))

        const { data: allComments } = await supabase
          .from('comments')
          .select('id, document_id')
          .in('document_id', docIds)

        const newCommentsMap = {}
        ;(allComments || []).forEach(c => {
          if (!readIds.has(c.id)) {
            newCommentsMap[c.document_id] = (newCommentsMap[c.document_id] || 0) + 1
          }
        })
        setNewComments(newCommentsMap)
      }
    } catch (err) {
      console.error('Error loading indicators:', err)
    }
  }, [profile])

  const updateStatus = useCallback(async (docId, status) => {
    try {
      const { error: updateError } = await supabase.from('documents').update({
        status,
        updated_at: new Date().toISOString()
      }).eq('id', docId)

      if (updateError) throw updateError

      await logAudit(profile.id, 'update_status', 'document', docId, { status })
      showToast('Статус оновлено', 'success')
      loadDocuments()
    } catch (err) {
      console.error('Status update error:', err)
      showToast('Помилка оновлення статусу', 'error')
    }
  }, [profile?.id, loadDocuments, showToast])

  // Memoized values
  const isAdmin = useMemo(() =>
    profile?.role === 'super_admin' || profile?.role === 'lawyer_admin',
    [profile?.role]
  )

  const isSuperAdmin = useMemo(() =>
    profile?.role === 'super_admin',
    [profile?.role]
  )

  const { totalDocs, completedDocs, progress } = useMemo(() => {
    const total = documents.length
    const completed = documents.filter(d => d.status === 'done').length
    return {
      totalDocs: total,
      completedDocs: completed,
      progress: total > 0 ? Math.round((completed / total) * 100) : 0
    }
  }, [documents])

  // Error state
  if (error) {
    return (
      <div className="error-container">
        <h2>⚠️ Помилка</h2>
        <p>{error}</p>
        <button onClick={() => window.location.reload()}>Перезавантажити</button>
      </div>
    )
  }

  if (loading) return <div className="loading">Завантаження... / Ładowanie...</div>
  if (!session) return <Auth />
  if (!profile) return <div className="loading">Завантаження профілю... / Ładowanie profilu...</div>

  return (
    <div className="app">
      {ToastComponent}

      <header>
        <h1>📋 Audit System | {selectedCompany?.name_uk}</h1>
        <div className="header-controls">
          <div className="user-info">
            <span>{profile.full_name || profile.email}</span>
            <span className="role">{ROLES[profile.role]?.uk}</span>
          </div>

          {isSuperAdmin && (
            <>
              <button onClick={() => setShowUserManagement(true)} title="Користувачі">👥</button>
              <button onClick={() => setShowAuditLog(true)} title="Журнал аудиту">📜</button>
            </>
          )}

          <select
            value={selectedCompany?.id || ''}
            onChange={e => {
              const company = companies.find(c => c.id === e.target.value)
              setSelectedCompany(company)
            }}
          >
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.name_uk} / {c.name_pl}</option>
            ))}
          </select>

          <button onClick={() => supabase.auth.signOut()}>🚪 Вийти</button>
        </div>
      </header>

      <div className="progress-bar">
        <div className="progress-track">
          <div className="progress" style={{ width: progress + '%' }}></div>
        </div>
        <span>{completedDocs} / {totalDocs} документів ({progress}%)</span>
      </div>

      <nav className="sections">
        {sections.map(s => (
          <button
            key={s.id}
            className={activeSection?.id === s.id ? 'active' : ''}
            onClick={() => setActiveSection(s)}
          >
            {s.code}. {s.name_uk?.substring(0, 20)}
          </button>
        ))}
      </nav>

      <main>
        <div className="section-header">
          <h2>
            <span className="section-code">{activeSection?.code}.</span>
            {activeSection?.name_uk} / {activeSection?.name_pl}
          </h2>
          {isAdmin && (
            <button className="btn-primary" onClick={() => setShowAddDocument(true)}>
              ➕ Додати документ
            </button>
          )}
        </div>

        <div className="documents">
          {documents.map(doc => {
            const hasNew = newDocuments.has(doc.id)
            const unreadComments = newComments[doc.id] || 0

            return (
              <div
                key={doc.id}
                className={`doc-item ${doc.status || 'pending'} ${hasNew ? 'new' : ''}`}
                onClick={() => setSelectedDocument(doc)}
              >
                {hasNew && <span className="new-badge">NEW</span>}
                {unreadComments > 0 && (
                  <span className="comments-badge" title={`${unreadComments} нових коментарів`}>
                    💬 {unreadComments}
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
                    👤 {doc.responsible.full_name || doc.responsible.email}
                  </span>
                )}

                <select
                  value={doc.status || 'pending'}
                  onChange={e => { e.stopPropagation(); updateStatus(doc.id, e.target.value) }}
                  onClick={e => e.stopPropagation()}
                  disabled={!isAdmin}
                >
                  {STATUS_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.uk}</option>
                  ))}
                </select>
              </div>
            )
          })}

          {documents.length === 0 && (
            <div className="no-docs">
              Немає документів в цьому розділі / Brak dokumentów w tej sekcji
            </div>
          )}
        </div>
      </main>

      {showUserManagement && (
        <UserManagement
          currentUser={profile}
          onClose={() => setShowUserManagement(false)}
          showToast={showToast}
        />
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
          showToast={showToast}
        />
      )}

      {showAddDocument && activeSection && (
        <AddDocumentModal
          section={activeSection}
          profile={profile}
          onClose={() => setShowAddDocument(false)}
          onAdded={loadDocuments}
          showToast={showToast}
        />
      )}
    </div>
  )
}
