import { useState, useEffect, useRef } from 'react'
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
        <h1>🔐 Audit System</h1>
        <p>Система управління документами<br/>System zarządzania dokumentami</p>
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

// File Upload Component
function FileUpload({ document, profile, onUpdate, canEdit }) {
  const [files, setFiles] = useState([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef(null)

  useEffect(() => {
    loadFiles()
  }, [document.id])

  const loadFiles = async () => {
    const { data } = await supabase
      .from('document_files')
      .select('*')
      .eq('document_id', document.id)
      .order('created_at')
    setFiles(data || [])
  }

  const handleUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files)
    if (files.length + selectedFiles.length > MAX_FILES_PER_DOC) {
      alert(`Максимум ${MAX_FILES_PER_DOC} файлів / Maximum ${MAX_FILES_PER_DOC} plików`)
      return
    }

    setUploading(true)
    for (const file of selectedFiles) {
      if (file.size > MAX_FILE_SIZE) {
        alert(`Файл ${file.name} перевищує 50MB / Plik ${file.name} przekracza 50MB`)
        continue
      }
      if (!file.type.includes('pdf')) {
        alert(`Тільки PDF файли / Tylko pliki PDF`)
        continue
      }

      const fileName = `${document.id}/${Date.now()}_${file.name}`
      const { error: uploadError } = await supabase.storage
        .from('documents')
        .upload(fileName, file)

      if (!uploadError) {
        await supabase.from('document_files').insert({
          document_id: document.id,
          file_name: file.name,
          file_path: fileName,
          file_size: file.size,
          uploaded_by: profile.id
        })

        // Log audit
        await logAudit(profile.id, 'upload_file', 'document_file', document.id, { file_name: file.name })
      }
    }
    setUploading(false)
    loadFiles()
    onUpdate()
    fileInputRef.current.value = ''
  }

  const handleDelete = async (fileId, filePath) => {
    if (!confirm('Видалити файл? / Usunąć plik?')) return

    await supabase.storage.from('documents').remove([filePath])
    await supabase.from('document_files').delete().eq('id', fileId)
    await logAudit(profile.id, 'delete_file', 'document_file', fileId, { file_path: filePath })
    loadFiles()
    onUpdate()
  }

  const handleDownload = async (filePath, fileName) => {
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
    const { data } = await supabase.storage.from('documents').createSignedUrl(filePath, 3600)
    if (data?.signedUrl) {
      window.open(data.signedUrl, '_blank')
      await logAudit(profile.id, 'view_file', 'document_file', document.id, { file_path: filePath })
    }
  }

  return (
    <div className="file-upload">
      <div className="files-header">
        <span>📎 Файли / Pliki ({files.length}/{MAX_FILES_PER_DOC})</span>
        {canEdit && files.length < MAX_FILES_PER_DOC && (
          <label className="upload-btn">
            {uploading ? '⏳' : '➕'}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
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

// Comments Component
function Comments({ document, profile, canComment, canView }) {
  const [comments, setComments] = useState([])
  const [newComment, setNewComment] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [unreadComments, setUnreadComments] = useState(new Set())

  useEffect(() => {
    if (canView) {
      loadComments()
      loadUnreadComments()
    }
  }, [document.id, canView])

  const loadComments = async () => {
    const { data } = await supabase
      .from('comments')
      .select('*, author:author_id(full_name, email)')
      .eq('document_id', document.id)
      .order('created_at')
    setComments(data || [])
  }

  const loadUnreadComments = async () => {
    const { data: readComments } = await supabase
      .from('comment_reads')
      .select('comment_id')
      .eq('user_id', profile.id)

    const readIds = new Set((readComments || []).map(r => r.comment_id))
    const { data: allComments } = await supabase
      .from('comments')
      .select('id')
      .eq('document_id', document.id)

    const unread = new Set()
    ;(allComments || []).forEach(c => {
      if (!readIds.has(c.id)) unread.add(c.id)
    })
    setUnreadComments(unread)
  }

  const markAsRead = async (commentId) => {
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
    if (!newComment.trim() || newComment.length > MAX_COMMENT_LENGTH) return

    setSubmitting(true)
    const { data, error } = await supabase.from('comments').insert({
      document_id: document.id,
      author_id: profile.id,
      content: newComment.trim(),
      parent_comment_id: replyTo
    }).select().single()

    if (!error) {
      await logAudit(profile.id, 'add_comment', 'comment', data.id, { document_id: document.id })
      setNewComment('')
      setReplyTo(null)
      loadComments()
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
              {submitting ? '...' : '📤 Надіслати / Wyślij'}
            </button>
          </div>
        </form>
      )}

      <div className="comments-list">
        {topLevelComments.map(comment => renderComment(comment))}
        {comments.length === 0 && <div className="no-comments">Немає коментарів / Brak komentarzy</div>}
      </div>
    </div>
  )
}

// Document Detail Modal
function DocumentDetail({ document, profile, onClose, onUpdate }) {
  const [doc, setDoc] = useState(document)
  const [users, setUsers] = useState([])
  const [editingResponsible, setEditingResponsible] = useState(false)

  const isAdmin = profile.role === 'super_admin' || profile.role === 'lawyer_admin'
  const isUserCat1 = profile.role === 'user_cat1'
  const canUpload = isAdmin || isUserCat1
  const canComment = !isUserCat1
  const canViewComments = !isUserCat1

  useEffect(() => {
    loadUsers()
    recordView()
  }, [])

  const loadUsers = async () => {
    const { data } = await supabase.from('profiles').select('id, full_name, email').eq('is_active', true)
    setUsers(data || [])
  }

  const recordView = async () => {
    await supabase.from('document_views').upsert({
      document_id: document.id,
      user_id: profile.id,
      viewed_at: new Date().toISOString()
    }, { onConflict: 'document_id,user_id' })
    await logAudit(profile.id, 'view_document', 'document', document.id)
  }

  const updateResponsible = async (userId) => {
    await supabase.from('documents').update({
      responsible_user_id: userId || null,
      updated_at: new Date().toISOString()
    }).eq('id', doc.id)
    await logAudit(profile.id, 'update_responsible', 'document', doc.id, { responsible_user_id: userId })

    const user = users.find(u => u.id === userId)
    setDoc({ ...doc, responsible_user_id: userId, responsible: user })
    setEditingResponsible(false)
    onUpdate()
  }

  const updateStatus = async (status) => {
    await supabase.from('documents').update({
      status,
      updated_at: new Date().toISOString()
    }).eq('id', doc.id)
    await logAudit(profile.id, 'update_status', 'document', doc.id, { status })
    setDoc({ ...doc, status })
    onUpdate()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal document-detail" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <span className="doc-code">{doc.code}</span>
            <h3>{doc.name_uk}</h3>
            <p className="doc-name-pl">{doc.name_pl}</p>
          </div>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="doc-info-row">
            <div className="info-item">
              <label>Статус / Status</label>
              <select value={doc.status || 'pending'} onChange={e => updateStatus(e.target.value)} disabled={!isAdmin}>
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
                >
                  <option value="">— Не призначено / Nie przypisano —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name || u.email}</option>
                  ))}
                </select>
              ) : (
                <div className="responsible-display" onClick={() => isAdmin && setEditingResponsible(true)}>
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

          <FileUpload document={doc} profile={profile} onUpdate={onUpdate} canEdit={canUpload} />

          <Comments document={doc} profile={profile} canComment={canComment} canView={canViewComments} />
        </div>
      </div>
    </div>
  )
}

// Add Document Modal
function AddDocumentModal({ section, profile, onClose, onAdded }) {
  const [nameUk, setNameUk] = useState('')
  const [namePl, setNamePl] = useState('')
  const [code, setCode] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)

    const { data, error } = await supabase.from('documents').insert({
      section_id: section.id,
      code: code || `${section.code}-X`,
      name_uk: nameUk,
      name_pl: namePl,
      status: 'pending',
      is_custom: true,
      order_index: 999
    }).select().single()

    if (!error) {
      await logAudit(profile.id, 'create_document', 'document', data.id, { name_uk: nameUk })
      onAdded()
      onClose()
    }
    setSubmitting(false)
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
            <label>Код / Kod</label>
            <input value={code} onChange={e => setCode(e.target.value)} placeholder={`${section.code}-X`} />
          </div>
          <div className="form-group">
            <label>Назва (UA) / Nazwa (UA)</label>
            <input value={nameUk} onChange={e => setNameUk(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Назва (PL) / Nazwa (PL)</label>
            <input value={namePl} onChange={e => setNamePl(e.target.value)} required />
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

// User Management Component
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
          full_name: newUser.full_name,
          role: newUser.role,
          is_active: true
        })
        await logAudit(currentUser.id, 'create_user', 'profile', data.user.id, { email: newUser.email, role: newUser.role })
      }

      setNewUser({ email: '', password: '', full_name: '', role: 'user_cat1' })
      loadUsers()
      alert('Користувача створено! / Użytkownik utworzony!')
    } catch (err) {
      alert('Помилка: ' + err.message)
    }
    setCreating(false)
  }

  const updateUserRole = async (userId, newRole) => {
    // Lawyer Admin cannot grant lawyer_auditor
    if (currentUser.role === 'lawyer_admin' && newRole === 'lawyer_auditor') {
      alert('Тільки Super Admin може призначити Lawyer Auditor')
      return
    }
    await supabase.from('profiles').update({ role: newRole }).eq('id', userId)
    await logAudit(currentUser.id, 'update_user_role', 'profile', userId, { new_role: newRole })
    loadUsers()
  }

  const toggleUserActive = async (userId, isActive) => {
    await supabase.from('profiles').update({ is_active: !isActive }).eq('id', userId)
    await logAudit(currentUser.id, isActive ? 'deactivate_user' : 'activate_user', 'profile', userId)
    loadUsers()
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
                <input placeholder="Email" type="email" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} required />
                <input placeholder="Пароль / Hasło" type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} required minLength={6} />
              </div>
              <div className="form-row">
                <input placeholder="Ім'я / Imię" value={newUser.full_name} onChange={e => setNewUser({...newUser, full_name: e.target.value})} required />
                <select value={newUser.role} onChange={e => setNewUser({...newUser, role: e.target.value})}>
                  {Object.entries(ROLES).map(([key, val]) => (
                    <option key={key} value={key}>{val.uk} / {val.pl}</option>
                  ))}
                </select>
              </div>
              <button type="submit" className="btn-primary" disabled={creating}>
                {creating ? '...' : '➕ Створити / Utwórz'}
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

// Audit Log Component
function AuditLog({ onClose }) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

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

  const filteredLogs = filter
    ? logs.filter(l => l.action.includes(filter) || l.user?.email?.includes(filter))
    : logs

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

          {loading ? (
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
                      {JSON.stringify(log.details)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Utility function for audit logging
async function logAudit(userId, action, entityType, entityId, details = null) {
  await supabase.from('audit_log').insert({
    user_id: userId,
    action,
    entity_type: entityType,
    entity_id: entityId,
    details
  })
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
  const [showUserManagement, setShowUserManagement] = useState(false)
  const [showAuditLog, setShowAuditLog] = useState(false)
  const [selectedDocument, setSelectedDocument] = useState(null)
  const [showAddDocument, setShowAddDocument] = useState(false)
  const [newDocuments, setNewDocuments] = useState(new Set())
  const [newComments, setNewComments] = useState({})

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

  const loadProfile = async (userId) => {
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

  useEffect(() => {
    if (activeSection) loadDocuments()
  }, [activeSection])

  const loadDocuments = async () => {
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

    // Load new documents indicator
    if (profile) {
      loadNewIndicators(data || [])
    }
  }

  const loadNewIndicators = async (docs) => {
    const docIds = docs.map(d => d.id)

    // Get documents user hasn't viewed
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

    // Get unread comments count per document
    if (profile.role !== 'user_cat1') {
      const newCommentsMap = {}
      for (const doc of docs) {
        const { count } = await supabase
          .from('comments')
          .select('id', { count: 'exact', head: true })
          .eq('document_id', doc.id)
          .not('id', 'in', `(SELECT comment_id FROM comment_reads WHERE user_id = '${profile.id}')`)

        if (count > 0) newCommentsMap[doc.id] = count
      }
      setNewComments(newCommentsMap)
    }
  }

  const updateStatus = async (docId, status) => {
    await supabase.from('documents').update({
      status,
      updated_at: new Date().toISOString()
    }).eq('id', docId)
    await logAudit(profile.id, 'update_status', 'document', docId, { status })
    loadDocuments()
  }

  if (loading) return <div className="loading">Завантаження... / Ładowanie...</div>
  if (!session) return <Auth />
  if (!profile) return <div className="loading">Завантаження профілю... / Ładowanie profilu...</div>

  const isAdmin = profile.role === 'super_admin' || profile.role === 'lawyer_admin'
  const isSuperAdmin = profile.role === 'super_admin'
  const totalDocs = documents.length
  const completedDocs = documents.filter(d => d.status === 'done').length
  const progress = totalDocs > 0 ? Math.round((completedDocs / totalDocs) * 100) : 0

  return (
    <div className="app">
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

          <select value={selectedCompany?.id || ''} onChange={e => {
            const company = companies.find(c => c.id === e.target.value)
            setSelectedCompany(company)
          }}>
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
                  <span className="comments-badge" title={`${unreadComments} нових коментарів}`}>
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
