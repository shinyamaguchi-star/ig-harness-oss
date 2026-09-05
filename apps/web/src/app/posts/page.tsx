'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  mediaPostsApi,
  engagementGatesApi,
  type EngagementGate,
  type MediaPostApi,
  type MediaPostMediaItem,
  type MediaPostType,
} from '@/lib/api'
import { convertReelCoverToJpeg } from '@/lib/reel-cover'
import Header from '@/components/layout/header'

const TYPE_LABELS: Record<MediaPostType, string> = {
  feed_image: 'フィード画像',
  carousel: 'カルーセル',
  reel: 'リール',
  story: 'ストーリー',
}

const STATUS_BADGES: Record<string, { label: string; bg: string; fg: string }> = {
  scheduled: { label: '予約済み', bg: '#EFF6FF', fg: '#1D4ED8' },
  processing: { label: '処理中', bg: '#FEF9C3', fg: '#A16207' },
  published: { label: '公開済み', bg: '#ECFDF5', fg: '#047857' },
  failed: { label: '失敗', bg: '#FEF2F2', fg: '#B91C1C' },
  canceled: { label: 'キャンセル', bg: '#F3F4F6', fg: '#6B7280' },
}

function acceptForType(postType: MediaPostType): string {
  if (postType === 'reel') return 'video/mp4,video/quicktime'
  if (postType === 'feed_image') return 'image/png,image/jpeg,image/gif,image/webp'
  return 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime'
}

function pickerLabelForType(postType: MediaPostType): string {
  if (postType === 'reel') return '動画を選択'
  if (postType === 'carousel') return '画像・動画を選択(2〜10枚)'
  if (postType === 'story') return '画像・動画を選択(1〜20件)'
  return '画像を選択'
}

function pickerHintForType(postType: MediaPostType): string {
  if (postType === 'reel') return 'MP4 / MOV、100MBまで'
  if (postType === 'feed_image') return 'PNG / JPG / GIF / WebP、5MBまで'
  return '画像 5MBまで・動画 100MBまで(MP4/MOV)'
}

function toDatetimeLocal(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export default function PostsPage() {
  const router = useRouter()
  const [posts, setPosts] = useState<MediaPostApi[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [quota, setQuota] = useState<{ quotaUsage: number; quotaTotal: number } | null>(null)
  const [campaigns, setCampaigns] = useState<EngagementGate[]>([])

  // form state
  const [title, setTitle] = useState('')
  const [postType, setPostType] = useState<MediaPostType>('feed_image')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const coverInputRef = useRef<HTMLInputElement>(null)
  const [mediaItems, setMediaItems] = useState<MediaPostMediaItem[]>([])
  const [reelCoverMode, setReelCoverMode] = useState<'default' | 'image' | 'frame'>('default')
  const [coverUrl, setCoverUrl] = useState('')
  const [thumbOffsetSeconds, setThumbOffsetSeconds] = useState('0')
  const [caption, setCaption] = useState('')
  const [mode, setMode] = useState<'now' | 'schedule'>('now')
  const [scheduledAt, setScheduledAt] = useState('')
  const [campaignMode, setCampaignMode] = useState<'none' | 'existing' | 'new'>('none')
  const [selectedCampaignId, setSelectedCampaignId] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [coverUploading, setCoverUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [items, limit, gates] = await Promise.all([
        mediaPostsApi.list(),
        mediaPostsApi.publishingLimit().catch(() => null),
        engagementGatesApi.list().catch(() => []),
      ])
      setPosts(items)
      setQuota(limit)
      setCampaigns(gates)
    } catch (err) {
      setError(err instanceof Error ? err.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    if (params.get('campaign_linked') === '1') {
      setNotice('予約投稿と自動応答を保存しました。投稿が公開されると自動応答も稼働します。')
      window.history.replaceState({}, '', window.location.pathname)
    }
  }, [])

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    const maxItems = postType === 'story' ? 20 : postType === 'carousel' ? 10 : 1
    const selected = Array.from(files)
    if (mediaItems.length + selected.length > maxItems) {
      setFormError(
        postType === 'story'
          ? 'ストーリーは1回の予約につき20件まで選択できます'
          : postType === 'carousel'
            ? 'カルーセルは10件まで選択できます'
            : 'この投稿形式で選択できるメディアは1件です',
      )
      return
    }
    setUploading(true)
    setFormError('')
    try {
      const uploaded: MediaPostMediaItem[] = []
      for (const file of selected) {
        const { url } = await mediaPostsApi.uploadMedia(file)
        uploaded.push({ url, type: file.type.startsWith('video/') ? 'video' : 'image' })
      }
      setMediaItems((prev) => [...prev, ...uploaded])
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'アップロードに失敗しました')
    } finally {
      setUploading(false)
    }
  }

  const handleCoverFile = async (file: File | null) => {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setFormError('表紙には画像ファイルを選択してください')
      return
    }
    setCoverUploading(true)
    setFormError('')
    try {
      const jpeg = await convertReelCoverToJpeg(file)
      const uploaded = await mediaPostsApi.uploadMedia(jpeg)
      if (uploaded.mimeType !== 'image/jpeg') {
        throw new Error('表紙画像がJPEGとして保存されませんでした')
      }
      const { url } = uploaded
      setCoverUrl(url)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '表紙画像のアップロードに失敗しました')
    } finally {
      setCoverUploading(false)
    }
  }

  const moveMediaItem = (from: number, to: number) => {
    setMediaItems((prev) => {
      if (to < 0 || to >= prev.length) return prev
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  const resetReelCover = () => {
    setReelCoverMode('default')
    setCoverUrl('')
    setThumbOffsetSeconds('0')
  }

  const resetForm = () => {
    setEditingId(null)
    setTitle('')
    setPostType('feed_image')
    setMediaItems([])
    setCaption('')
    setScheduledAt('')
    setMode('now')
    setCampaignMode('none')
    setSelectedCampaignId('')
    setFormError('')
    resetReelCover()
  }

  const beginEdit = (post: MediaPostApi) => {
    if (post.status !== 'scheduled') return
    setEditingId(post.id)
    setTitle(post.title ?? '')
    setPostType(post.postType)
    setMediaItems(post.media)
    setCaption(post.caption ?? '')
    setMode('schedule')
    setScheduledAt(toDatetimeLocal(post.scheduledAt))
    if (post.coverUrl) {
      setReelCoverMode('image')
      setCoverUrl(post.coverUrl)
      setThumbOffsetSeconds('0')
    } else if (post.thumbOffsetMs !== null) {
      setReelCoverMode('frame')
      setCoverUrl('')
      setThumbOffsetSeconds(String(post.thumbOffsetMs / 1000))
    } else {
      resetReelCover()
    }
    if (post.campaignGateId) {
      setCampaignMode('existing')
      setSelectedCampaignId(post.campaignGateId)
    } else {
      setCampaignMode('none')
      setSelectedCampaignId('')
    }
    setFormError('')
    setNotice('予約投稿の内容を編集中です。保存するまで変更は反映されません。')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const eligibleCampaigns = campaigns.filter(
    (gate) =>
      gate.trigger_type === 'comment_on_post' &&
      gate.status !== 'archived' &&
      !(gate.status === 'active' && (gate.target_post_ids?.length ?? 0) === 0),
  )

  const submit = async () => {
    setFormError('')
    if (mediaItems.length === 0) {
      setFormError('メディアをアップロードしてください')
      return
    }
    if (mode === 'schedule' && !scheduledAt) {
      setFormError('予約日時を指定してください')
      return
    }
    if (campaignMode === 'existing' && !selectedCampaignId) {
      setFormError('紐づけるキャンペーンを選択してください')
      return
    }
    if (postType === 'reel' && reelCoverMode === 'image' && !coverUrl) {
      setFormError('表紙画像をアップロードしてください')
      return
    }
    const thumbOffsetMs = Math.round(Number(thumbOffsetSeconds) * 1000)
    if (
      postType === 'reel' &&
      reelCoverMode === 'frame' &&
      (!Number.isFinite(thumbOffsetMs) || thumbOffsetMs < 0)
    ) {
      setFormError('表紙にする動画の位置を0秒以上で入力してください')
      return
    }
    setSubmitting(true)
    try {
      const campaignGateId = campaignMode === 'existing' ? selectedCampaignId : null
      const payload = {
        title: title.trim() || null,
        postType,
        media: mediaItems,
        caption: caption || null,
        coverUrl: postType === 'reel' && reelCoverMode === 'image' ? coverUrl : null,
        thumbOffsetMs:
          postType === 'reel' && reelCoverMode === 'frame' ? thumbOffsetMs : null,
        scheduledAt: mode === 'schedule' ? new Date(scheduledAt).toISOString() : undefined,
        campaignGateId,
      }
      const post = editingId
        ? await mediaPostsApi.update(editingId, {
            ...payload,
            scheduledAt: new Date(scheduledAt).toISOString(),
          })
        : await mediaPostsApi.create({
            ...payload,
            title: payload.title ?? undefined,
            caption: payload.caption ?? undefined,
            coverUrl: payload.coverUrl ?? undefined,
            thumbOffsetMs: payload.thumbOffsetMs ?? undefined,
            campaignGateId: payload.campaignGateId ?? undefined,
          })
      if (mode === 'schedule' && campaignMode === 'new') {
        router.push(`/campaigns/new?scheduled_post_id=${encodeURIComponent(post.id)}`)
        return
      }
      setNotice(editingId ? '予約投稿を更新しました。' : '予約投稿を保存しました。')
      resetForm()
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '投稿の作成に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const cancel = async (id: string) => {
    if (!window.confirm('この予約投稿をキャンセルしますか?')) return
    try {
      await mediaPostsApi.cancel(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'キャンセルに失敗しました')
    }
  }

  const publishNow = async (id: string) => {
    if (!window.confirm('今すぐ公開しますか? Instagram に公開投稿されます。')) return
    try {
      await mediaPostsApi.publishNow(id)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '公開に失敗しました')
    }
  }

  return (
    <div>
      <Header title="投稿" />
      <div style={{ maxWidth: 960 }}>
        {quota && (
          <p style={{ fontSize: 13, color: '#6B7280', marginBottom: 16 }}>
            24時間の投稿枠: {quota.quotaUsage}/{quota.quotaTotal}
          </p>
        )}
        {notice && (
          <div style={{ marginBottom: 16, padding: 12, borderRadius: 10, border: '1px solid #A7F3D0', background: '#ECFDF5', color: '#047857', fontSize: 13 }}>
            {notice}
          </div>
        )}

        {/* ─── 投稿作成・編集フォーム ─── */}
        <section style={{ border: '1px solid #E5E7EB', borderRadius: 12, padding: 20, marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
              {editingId ? '予約投稿を確認・編集' : '新規投稿'}
            </h2>
            {editingId && (
              <button type="button" onClick={resetForm} style={{ border: '1px solid #D1D5DB', borderRadius: 8, background: 'white', color: '#6B7280', padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
                編集をやめる
              </button>
            )}
          </div>

          <label style={{ display: 'block', marginBottom: 16 }}>
            <span style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600, color: '#374151' }}>
              投稿タイトル <span style={{ fontWeight: 400, color: '#9CA3AF' }}>（管理用・Instagramには表示されません）</span>
            </span>
            <input
              type="text"
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例：8月25日 復縁キャンペーン用リール"
              style={{ width: '100%', border: '1px solid #D1D5DB', borderRadius: 8, padding: '9px 10px', fontSize: 14 }}
            />
            <span style={{ display: 'block', marginTop: 4, textAlign: 'right', fontSize: 11, color: '#9CA3AF' }}>
              {title.length}/100
            </span>
          </label>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {(Object.keys(TYPE_LABELS) as MediaPostType[]).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setPostType(t)
                  setMediaItems([])
                  resetReelCover()
                  if (t === 'story') {
                    setCampaignMode('none')
                    setSelectedCampaignId('')
                  }
                }}
                style={{
                  padding: '6px 14px',
                  borderRadius: 20,
                  border: '1px solid',
                  borderColor: postType === t ? '#E1306C' : '#D1D5DB',
                  background: postType === t ? '#FDF2F8' : 'white',
                  color: postType === t ? '#E1306C' : '#374151',
                  fontSize: 13,
                  cursor: 'pointer',
                }}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={acceptForType(postType)}
            multiple={postType === 'carousel' || postType === 'story'}
            onChange={(e) => {
              void handleFiles(e.target.files)
              // allow re-selecting the same file after removal
              e.target.value = ''
            }}
            disabled={uploading}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            style={{
              width: '100%',
              padding: '20px 16px',
              border: '2px dashed #D1D5DB',
              borderRadius: 12,
              background: '#FAFAFA',
              color: '#374151',
              fontSize: 14,
              cursor: uploading ? 'default' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              opacity: uploading ? 0.7 : 1,
            }}
          >
            <span style={{ fontSize: 22 }} aria-hidden="true">{uploading ? '⏳' : '📁'}</span>
            <span style={{ fontWeight: 600 }}>
              {uploading ? 'アップロード中…' : pickerLabelForType(postType)}
            </span>
            {!uploading && (
              <span style={{ fontSize: 12, color: '#9CA3AF' }}>{pickerHintForType(postType)}</span>
            )}
          </button>

          {mediaItems.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
              {mediaItems.map((item, i) => (
                <div
                  key={`${item.url}-${i}`}
                  style={{
                    position: 'relative',
                    padding: postType === 'carousel' || postType === 'story' ? 3 : 0,
                    border: postType === 'carousel' && i === 0 ? '2px solid #E1306C' : '2px solid transparent',
                    borderRadius: 10,
                  }}
                >
                  {item.type === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={item.url} alt="" style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8 }} />
                  ) : (
                    <video src={item.url} style={{ width: 96, height: 96, objectFit: 'cover', borderRadius: 8 }} />
                  )}
                  <button
                    type="button"
                    onClick={() => setMediaItems((prev) => prev.filter((_, j) => j !== i))}
                    style={{ position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, border: 'none', background: '#111827', color: 'white', fontSize: 11, cursor: 'pointer' }}
                    aria-label="削除"
                  >
                    ×
                  </button>
                  {postType === 'carousel' && i === 0 && (
                    <span style={{ position: 'absolute', left: 7, top: 7, padding: '2px 7px', borderRadius: 10, background: '#E1306C', color: 'white', fontSize: 10, fontWeight: 700 }}>
                      表紙
                    </span>
                  )}
                  {postType === 'story' && (
                    <span style={{ position: 'absolute', left: 7, top: 7, width: 22, height: 22, borderRadius: 11, background: '#2563EB', color: 'white', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      {i + 1}
                    </span>
                  )}
                  {(postType === 'carousel' || postType === 'story') && (
                    <div style={{ display: 'flex', justifyContent: 'center', gap: 4, marginTop: 4 }}>
                      <button
                        type="button"
                        onClick={() => moveMediaItem(i, i - 1)}
                        disabled={i === 0}
                        aria-label="左へ移動"
                        style={{ width: 28, height: 24, border: '1px solid #D1D5DB', borderRadius: 6, background: 'white', color: '#374151', cursor: i === 0 ? 'default' : 'pointer', opacity: i === 0 ? 0.35 : 1 }}
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        onClick={() => moveMediaItem(i, i + 1)}
                        disabled={i === mediaItems.length - 1}
                        aria-label="右へ移動"
                        style={{ width: 28, height: 24, border: '1px solid #D1D5DB', borderRadius: 6, background: 'white', color: '#374151', cursor: i === mediaItems.length - 1 ? 'default' : 'pointer', opacity: i === mediaItems.length - 1 ? 0.35 : 1 }}
                      >
                        →
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {postType === 'carousel' && mediaItems.length > 0 && (
            <p style={{ fontSize: 12, color: '#6B7280', margin: '0 0 12px' }}>
              一番左のメディアが投稿の表紙になります。矢印で順番を変更できます。
            </p>
          )}

          {postType === 'story' && mediaItems.length > 0 && (
            <p style={{ fontSize: 12, color: '#6B7280', margin: '0 0 12px' }}>
              左から順に、それぞれ独立したストーリーとして連続公開します。矢印で順番を変更できます。
            </p>
          )}

          {postType === 'reel' && (
            <div style={{ marginTop: 16, padding: 14, border: '1px solid #E5E7EB', borderRadius: 10, background: '#FAFAFA' }}>
              <p style={{ margin: '0 0 10px', fontSize: 14, fontWeight: 600, color: '#374151' }}>リールの表紙</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
                <label style={{ fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="reel-cover-mode"
                    checked={reelCoverMode === 'default'}
                    onChange={() => setReelCoverMode('default')}
                  />{' '}
                  自動（動画の先頭フレーム）
                </label>
                <label style={{ fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="reel-cover-mode"
                    checked={reelCoverMode === 'image'}
                    onChange={() => setReelCoverMode('image')}
                  />{' '}
                  表紙画像をアップロード
                </label>
                {reelCoverMode === 'image' && (
                  <div style={{ marginLeft: 22 }}>
                    <input
                      ref={coverInputRef}
                      type="file"
                      accept="image/jpeg,image/png"
                      onChange={(e) => {
                        void handleCoverFile(e.target.files?.[0] ?? null)
                        e.target.value = ''
                      }}
                      disabled={coverUploading}
                      style={{ display: 'none' }}
                    />
                    {coverUrl ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={coverUrl} alt="選択したリール表紙" style={{ width: 72, height: 96, objectFit: 'cover', borderRadius: 8 }} />
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" onClick={() => coverInputRef.current?.click()} style={{ padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 7, background: 'white', color: '#374151', fontSize: 12, cursor: 'pointer' }}>
                            変更
                          </button>
                          <button type="button" onClick={() => setCoverUrl('')} style={{ padding: '6px 10px', border: '1px solid #D1D5DB', borderRadius: 7, background: 'white', color: '#6B7280', fontSize: 12, cursor: 'pointer' }}>
                            削除
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => coverInputRef.current?.click()}
                        disabled={coverUploading}
                        style={{ padding: '8px 12px', border: '1px solid #D1D5DB', borderRadius: 8, background: 'white', color: '#374151', fontSize: 12, cursor: coverUploading ? 'default' : 'pointer' }}
                      >
                        {coverUploading ? 'JPEGへ変換してアップロード中…' : '画像を選択（JPG / PNG → JPEGへ自動変換）'}
                      </button>
                    )}
                  </div>
                )}
                <label style={{ fontSize: 13, color: '#374151', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="reel-cover-mode"
                    checked={reelCoverMode === 'frame'}
                    onChange={() => setReelCoverMode('frame')}
                  />{' '}
                  動画内の位置を指定
                </label>
                {reelCoverMode === 'frame' && (
                  <label style={{ marginLeft: 22, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#6B7280' }}>
                    動画の先頭から
                    <input
                      type="number"
                      min="0"
                      step="0.1"
                      value={thumbOffsetSeconds}
                      onChange={(e) => setThumbOffsetSeconds(e.target.value)}
                      style={{ width: 90, border: '1px solid #D1D5DB', borderRadius: 7, padding: '6px 8px', fontSize: 13 }}
                    />
                    秒
                  </label>
                )}
              </div>
              <p style={{ margin: '10px 0 0', fontSize: 11, lineHeight: 1.6, color: '#9CA3AF' }}>
                Instagram側の表示場所や縦横比により、表紙の一部が切り取られて見える場合があります。
              </p>
            </div>
          )}

          {postType !== 'story' && (
            <textarea
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="キャプション(ハッシュタグ可)"
              rows={4}
              style={{ width: '100%', border: '1px solid #D1D5DB', borderRadius: 8, padding: 10, fontSize: 14, marginTop: 8 }}
            />
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 12 }}>
            {!editingId && (
              <label style={{ fontSize: 14 }}>
                <input
                  type="radio"
                  checked={mode === 'now'}
                  onChange={() => {
                    setMode('now')
                    setCampaignMode('none')
                    setSelectedCampaignId('')
                  }}
                /> 今すぐ投稿
              </label>
            )}
            <label style={{ fontSize: 14 }}>
              <input type="radio" checked={mode === 'schedule'} onChange={() => setMode('schedule')} /> 日時指定
            </label>
            {mode === 'schedule' && (
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                style={{ border: '1px solid #D1D5DB', borderRadius: 8, padding: 6 }}
              />
            )}
          </div>
          {mode === 'schedule' && (
            <>
              <p style={{ fontSize: 12, color: '#9CA3AF', marginTop: 4 }}>
                ※ 公開は指定時刻から最大3分程度ずれる場合があります（2分・3分交互の定期処理）
              </p>
              {postType !== 'story' && (
                <div style={{ marginTop: 14, padding: 14, border: '1px solid #D1D5DB', borderRadius: 10, background: '#FAFAFA' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#374151', marginBottom: 10 }}>
                    コメント自動応答キャンペーン
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <label style={{ fontSize: 13, color: '#374151' }}>
                      <input type="radio" checked={campaignMode === 'none'} onChange={() => { setCampaignMode('none'); setSelectedCampaignId('') }} /> 設定しない
                    </label>
                    <label style={{ fontSize: 13, color: '#374151' }}>
                      <input type="radio" checked={campaignMode === 'existing'} onChange={() => setCampaignMode('existing')} /> 既存のキャンペーンを選ぶ
                    </label>
                    {campaignMode === 'existing' && (
                      <select
                        value={selectedCampaignId}
                        onChange={(e) => setSelectedCampaignId(e.target.value)}
                        style={{ marginLeft: 22, maxWidth: 520, border: '1px solid #D1D5DB', borderRadius: 8, padding: '8px 10px', background: 'white', fontSize: 13 }}
                      >
                        <option value="">キャンペーンを選択してください</option>
                        {eligibleCampaigns.map((gate) => (
                          <option key={gate.id} value={gate.id}>
                            {gate.name}（{gate.status === 'active' ? '稼働中' : '一時停止'}）
                          </option>
                        ))}
                      </select>
                    )}
                    {campaignMode === 'existing' && eligibleCampaigns.length === 0 && (
                      <div style={{ marginLeft: 22, fontSize: 12, color: '#A16207' }}>
                        選択できるコメントキャンペーンがありません。
                      </div>
                    )}
                    <label style={{ fontSize: 13, color: '#374151' }}>
                      <input type="radio" checked={campaignMode === 'new'} onChange={() => { setCampaignMode('new'); setSelectedCampaignId('') }} /> 新しいキャンペーンを作成する
                    </label>
                    {campaignMode === 'new' && (
                      <div style={{ marginLeft: 22, fontSize: 12, color: '#6B7280' }}>
                        予約投稿を保存した後、キャンペーン設定画面へ進みます。
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {formError && <p style={{ color: '#B91C1C', fontSize: 13, marginTop: 8 }}>{formError}</p>}

          <button
            onClick={() => void submit()}
            disabled={submitting || uploading || coverUploading}
            style={{ marginTop: 16, padding: '10px 24px', borderRadius: 8, border: 'none', background: '#E1306C', color: 'white', fontWeight: 600, cursor: 'pointer', opacity: submitting ? 0.6 : 1 }}
          >
            {submitting
              ? '送信中…'
              : editingId
                ? '変更を保存'
                : mode === 'now'
                ? '投稿する'
                : campaignMode === 'new'
                  ? '予約して自動応答を設定'
                  : '予約する'}
          </button>
        </section>

        {/* ─── 投稿一覧 ─── */}
        <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>投稿一覧</h2>
        {error && <p style={{ color: '#B91C1C', fontSize: 13 }}>{error}</p>}
        {loading ? (
          <p>読み込み中…</p>
        ) : posts.length === 0 ? (
          <p style={{ color: '#6B7280', fontSize: 14 }}>投稿はまだありません</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {posts.map((post) => {
              const badge = STATUS_BADGES[post.status] ?? STATUS_BADGES.canceled
              const linkedCampaign = campaigns.find((gate) => gate.id === post.campaignGateId)
              return (
                <div key={post.id} style={{ border: '1px solid #E5E7EB', borderRadius: 12, padding: 16, display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  {post.coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={post.coverUrl} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
                  ) : post.media[0] && post.media[0].type === 'image' ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={post.media[0].url} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }} />
                  ) : (
                    <div style={{ width: 72, height: 72, borderRadius: 8, background: '#F3F4F6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24, flexShrink: 0 }}>🎬</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <p style={{ fontSize: 14, fontWeight: 700, color: post.title ? '#111827' : '#9CA3AF', margin: '0 0 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {post.title || 'タイトル未設定'}
                    </p>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                      <span style={{ fontSize: 12, padding: '2px 10px', borderRadius: 10, background: badge.bg, color: badge.fg, fontWeight: 600 }}>{badge.label}</span>
                      <span style={{ fontSize: 13, color: '#374151' }}>{TYPE_LABELS[post.postType]}</span>
                      {(post.postType === 'carousel' || post.postType === 'story') && (
                        <span style={{ fontSize: 12, color: '#9CA3AF' }}>{post.media.length}件</span>
                      )}
                    </div>
                    {post.caption && (
                      <p style={{ fontSize: 13, color: '#4B5563', margin: '4px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{post.caption}</p>
                    )}
                    {post.postType === 'reel' && (post.coverUrl || post.thumbOffsetMs !== null) && (
                      <p style={{ fontSize: 12, color: '#6B7280', margin: '4px 0 0' }}>
                        表紙: {post.coverUrl ? 'アップロード画像' : `動画の先頭から ${(post.thumbOffsetMs ?? 0) / 1000}秒`}
                      </p>
                    )}
                    <p style={{ fontSize: 12, color: '#9CA3AF', margin: 0 }}>
                      {post.status === 'scheduled' ? `予約: ${post.scheduledAt}` : `更新: ${post.updatedAt}`}
                      {post.publishedMediaId && ` / media_id: ${post.publishedMediaId}`}
                    </p>
                    {post.error && (
                      <div style={{ fontSize: 12, color: '#B91C1C', marginTop: 4 }}>
                        <p style={{ margin: 0 }}>{post.error}</p>
                        {(post.lastAttemptAt || post.nextRetryAt) && (
                          <p style={{ margin: '2px 0 0', color: '#6B7280' }}>
                            {post.lastAttemptAt ? `最終試行: ${new Date(post.lastAttemptAt).toLocaleString('ja-JP')}` : ''}
                            {post.lastAttemptAt && post.nextRetryAt ? ' / ' : ''}
                            {post.nextRetryAt ? `次回再試行: ${new Date(post.nextRetryAt).toLocaleString('ja-JP')}` : ''}
                            {` / 試行 ${post.attemptCount}回`}
                          </p>
                        )}
                      </div>
                    )}
                    {post.campaignGateId && (
                      <div style={{ fontSize: 12, marginTop: 4 }}>
                        <p
                          style={{
                            color:
                              post.campaignActivationStatus === 'active'
                                ? '#047857'
                                : post.campaignActivationStatus === 'failed'
                                  ? '#B91C1C'
                                  : '#A16207',
                            margin: 0,
                          }}
                        >
                          自動応答: {post.campaignActivationStatus === 'active'
                            ? '紐づけ済み'
                            : post.campaignActivationStatus === 'failed'
                              ? '開始失敗'
                              : post.campaignActivationStatus === 'canceled'
                                ? 'キャンセル済み'
                                : '公開待ち'}
                          {post.campaignError ? `（${post.campaignError}）` : ''}
                        </p>
                        <p style={{ color: '#6B7280', margin: '2px 0 0' }}>
                          キャンペーン: {linkedCampaign?.name ?? post.campaignGateId}
                        </p>
                      </div>
                    )}
                  </div>
                  {post.status === 'scheduled' && (
                    <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                      <button onClick={() => beginEdit(post)} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid #2563EB', background: 'white', color: '#2563EB', cursor: 'pointer' }}>確認・編集</button>
                      <button onClick={() => void publishNow(post.id)} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid #E1306C', background: 'white', color: '#E1306C', cursor: 'pointer' }}>今すぐ公開</button>
                      <button onClick={() => void cancel(post.id)} style={{ fontSize: 12, padding: '6px 12px', borderRadius: 8, border: '1px solid #D1D5DB', background: 'white', color: '#6B7280', cursor: 'pointer' }}>キャンセル</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
