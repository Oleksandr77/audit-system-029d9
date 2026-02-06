import { useState, useEffect, useRef } from 'react'
import { supabase } from './lib/supabase'

// Role labels / Назви ролей
const ROLES = {
  super_admin: { uk: 'Супер Адмін', pl: 'Super Admin' },
  lawyer_admin: { uk: 'Юрист Адмін', pl: 'Prawnik Admin' },
  lawyer_auditor: { uk: 'Юрист Аудитор', pl: 'Prawnik Audytor' },
  user_cat1: { uk: 'Користувач', pl: 'Użytkownik' }
}const STATUS_OPTIONS = [
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
const STATUS_OPTIONS = [
  { value: 'pending', uk: '⏳ Очікує', pl: '⏳ Oczekuje' },
  { value: 'in_progress', uk: ' В роботі', pl: ' W trakcie' },
  { value: 'done', uk: '✔ Гotovo', pl: '✔ Gotowe' },
  { value: 'missing', uk: '❌ Віdsutnій', pl: '❌ Brak' }
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
        <h1> Audit System</h1>
        <p>Система управління документами<br/>System zarzёdzania dokumentami</p>
        <form onSubmit={handleSubmit}>
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <input type="password" placeholder="Пароль / Hasкo" value={password} onChange={e => setPassword(e.target.value)} required />
          {error && <div className="error">{error}</div>}
          <button type="submit" disabled={loading}>{loading ? '...' : 'Увійти / Zaloguj'}</button>
        </form>
      </div>
    </div>
  )
}
           style={{ display: 'none' }}
            />
          </label>
        }
      </div>
      <div className="files-list">
        {files.map(file => (
          <div key={file.id} className="file-item">
            <span className="file-icon">ð</span>
            <span className="file-name" title={file.file_name}>{file.file_name}</span>
            <span className="file-size">{(file.file_size / 1024 / 1024).toFixed(1)}MB</span>
            <div className="file-actions">
              <button onClick={() => handlePreview(file.file_path)} title="Пereglянuti / Podglёd">ð</button>
              <button onClick={() => handleDownload(file.file_path, file.file_name)} title="Зavantaxiti / Pobierz">⬇</button>
              {canEdit && <button onClick={() => handleDelete(file.id, file.file_path)} title="Вidаliti / Usun">ð</button>}
            </div>
          </div>
        )}
        {files.length === 0 && <div className="no-files">Нemаe fайlі / Brak plikоw</div>}
      </div>
    </div>
  )
}T_LENGTH}
          />
          <div className="comment-footer">
            <span className="char-count">{newComment.length}/{MAX_COMMENT_LENGTH}</span>
            <button type="submit" disabled={submitting || !newComment.trim()}>
              {submitting ? '...' : ' Надіслати / Wyślij'}
            </button>
          </div>
        </form>
      )}

      <div className="comments-list">
        {topLevelComments.map(comment => renderComment(comment))}
        {comments.length === 0 && <div className="no-comments">Немал коментарів / Brak komentarzy</div>}
      </div>
    </div>
  )
}

// Document Detail Modal
function DocumentDetail({ document, profile, onClose, onUpdate }) {
  const [doc, setDoc] = useState(document)
  const [users, setUsers] = useState([])
  const [editingResponsible, setEditingResponsible] = useState(false)      onUpdate()
    fileInputRef.current.value = ''
  }

  const handleDelete = async (fileId, filePath) => {
    if (!confirm('Вidаliti fайl? / Usunнч plik?')) return

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
        <span>ð Файlи / Pliki ({files.length}/{MAX_FILES_PER_DOC})</span>
        {canEdit && files.length < MAX_FILES_PER_DOC && (
          <label className="upload-btn">
            {uploading ? 'ð ' : 'ð±'}
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
      <div className="files-list">}
        
