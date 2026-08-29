'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Header from '@/components/layout/header'
import {
  api,
  broadcastsApi,
  type BroadcastApi,
  type BroadcastDeliveryApi,
  type BroadcastMessageType,
} from '@/lib/api'
import type { Tag } from '@ig-harness/shared'

const ACCENT = '#E1306C'

const STATUS: Record<string, { label: string; classes: string }> = {
  draft: { label: '下書き', classes: 'bg-gray-100 text-gray-600' },
  scheduled: { label: '予約済み', classes: 'bg-blue-100 text-blue-700' },
  sending: { label: '送信中', classes: 'bg-yellow-100 text-yellow-700' },
  sent: { label: '送信完了', classes: 'bg-green-100 text-green-700' },
}

function toDatetimeLocal(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function readBody(item: BroadcastApi): { content: string; advanced: string } {
  try {
    const body = JSON.parse(item.body) as Record<string, unknown>
    if (item.messageType === 'text') return { content: String(body.text ?? ''), advanced: '' }
    if (item.messageType === 'image') return { content: String(body.url ?? ''), advanced: '' }
  } catch {
    // Preserve malformed legacy JSON in the advanced editor for repair.
  }
  return { content: '', advanced: item.body }
}

function parseTagId(filter: string | null): string {
  if (!filter) return ''
  try {
    const parsed = JSON.parse(filter) as { tagId?: string | number }
    return parsed.tagId == null ? '' : String(parsed.tagId)
  } catch {
    return ''
  }
}

export default function BroadcastsPage() {
  const [items, setItems] = useState<BroadcastApi[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  const [name, setName] = useState('')
  const [messageType, setMessageType] = useState<BroadcastMessageType>('text')
  const [content, setContent] = useState('')
  const [advancedBody, setAdvancedBody] = useState('')
  const [audienceMode, setAudienceMode] = useState<'all' | 'tag'>('all')
  const [tagId, setTagId] = useState('')
  const [deliveryMode, setDeliveryMode] = useState<'draft' | 'schedule'>('draft')
  const [scheduledAt, setScheduledAt] = useState('')
  const [audienceCount, setAudienceCount] = useState<number | null>(null)

  const [resultsFor, setResultsFor] = useState<number | null>(null)
  const [deliveries, setDeliveries] = useState<BroadcastDeliveryApi[]>([])
  const [resultsLoading, setResultsLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [broadcasts, tagResponse] = await Promise.all([
        broadcastsApi.list(),
        api.tags.list(),
      ])
      setItems(broadcasts)
      setTags(tagResponse.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '一斉配信の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    let active = true
    const selectedTag = audienceMode === 'tag' ? tagId : undefined
    if (audienceMode === 'tag' && !tagId) {
      setAudienceCount(null)
      return
    }
    broadcastsApi.audienceCount(selectedTag)
      .then((count) => { if (active) setAudienceCount(count) })
      .catch(() => { if (active) setAudienceCount(null) })
    return () => { active = false }
  }, [audienceMode, tagId])

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setMessageType('text')
    setContent('')
    setAdvancedBody('')
    setAudienceMode('all')
    setTagId('')
    setDeliveryMode('draft')
    setScheduledAt('')
  }

  const beginEdit = (item: BroadcastApi) => {
    const body = readBody(item)
    const selectedTag = parseTagId(item.tagFilter)
    setEditingId(item.id)
    setName(item.name)
    setMessageType(item.messageType)
    setContent(body.content)
    setAdvancedBody(body.advanced)
    setAudienceMode(selectedTag ? 'tag' : 'all')
    setTagId(selectedTag)
    setDeliveryMode(item.scheduledAt ? 'schedule' : 'draft')
    setScheduledAt(toDatetimeLocal(item.scheduledAt))
    setError('')
    setNotice('')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const buildBody = (): string => {
    if (messageType === 'text') {
      if (!content.trim()) throw new Error('送信する文章を入力してください')
      return JSON.stringify({ text: content.trim() })
    }
    if (messageType === 'image') {
      try { new URL(content.trim()) } catch { throw new Error('画像の有効なURLを入力してください') }
      return JSON.stringify({ url: content.trim() })
    }
    try {
      const parsed = JSON.parse(advancedBody)
      return JSON.stringify(parsed)
    } catch {
      throw new Error('高度なメッセージ設定は正しいJSON形式で入力してください')
    }
  }

  const save = async () => {
    setError('')
    setNotice('')
    if (!name.trim()) { setError('管理用の配信名を入力してください'); return }
    if (audienceMode === 'tag' && !tagId) { setError('送信対象のタグを選択してください'); return }
    if (deliveryMode === 'schedule' && !scheduledAt) { setError('配信日時を入力してください'); return }
    if (deliveryMode === 'schedule' && new Date(scheduledAt).getTime() <= Date.now()) {
      setError('予約日時は現在より後にしてください'); return
    }
    setBusy(true)
    try {
      const input = {
        name: name.trim(),
        messageType,
        body: buildBody(),
        tagFilter: audienceMode === 'tag' ? JSON.stringify({ tagId }) : null,
        scheduledAt: deliveryMode === 'schedule' ? new Date(scheduledAt).toISOString() : null,
      }
      if (editingId) await broadcastsApi.update(editingId, input)
      else await broadcastsApi.create(input)
      setNotice(editingId ? '一斉配信を更新しました' : deliveryMode === 'schedule' ? '一斉配信を予約しました' : '下書きを保存しました')
      resetForm()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const sendNow = async (item: BroadcastApi) => {
    setError('')
    let count: number | null = null
    try {
      count = await broadcastsApi.audienceCount(parseTagId(item.tagFilter) || undefined)
    } catch {
      // Sending is still possible when the preview request alone fails.
    }
    if (count === 0) {
      setError('送信対象者が0人のため送信できません。フォロワー情報またはタグ設定を確認してください。')
      return
    }
    const countLabel = count == null ? '現在の対象者' : `${count}人の対象者`
    if (!window.confirm(`「${item.name}」を${countLabel}へ今すぐ送信します。\n送信開始後は取り消せません。実行しますか？`)) return
    setBusy(true)
    setNotice('送信処理を開始しました。完了まで画面を閉じずにお待ちください。')
    try {
      const result = await broadcastsApi.send(item.id)
      setNotice(`送信完了：成功 ${result.successCount}件 / 失敗 ${result.failureCount}件`)
      await load()
      if (result.failureCount > 0) await showResults(result.id, 'failed')
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
      await load()
    } finally {
      setBusy(false)
    }
  }

  const remove = async (item: BroadcastApi) => {
    if (!window.confirm(`「${item.name}」を削除しますか？`)) return
    setBusy(true)
    try {
      await broadcastsApi.delete(item.id)
      if (resultsFor === item.id) { setResultsFor(null); setDeliveries([]) }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const showResults = async (id: number, status?: 'success' | 'failed') => {
    setResultsFor(id)
    setResultsLoading(true)
    try {
      setDeliveries(await broadcastsApi.deliveries(id, status))
    } catch (err) {
      setError(err instanceof Error ? err.message : '配信結果の取得に失敗しました')
    } finally {
      setResultsLoading(false)
    }
  }

  const selectedResult = useMemo(() => items.find((item) => item.id === resultsFor), [items, resultsFor])

  return (
    <div>
      <Header title="一斉配信" description="対象者を選び、Instagram DMを一括送信・予約します" />

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
        送信可否は最終的にMeta APIが判定します。送信できなかった相手は、配信後の「失敗理由」で確認できます。
      </div>
      {error && <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-700">{notice}</div>}

      <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
        <h2 className="mb-4 text-base font-semibold">{editingId ? '一斉配信を編集' : '新しい一斉配信'}</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <label className="text-sm font-medium text-gray-700">
            管理用の配信名
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：8月キャンペーンのお知らせ" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 font-normal" />
          </label>
          <label className="text-sm font-medium text-gray-700">
            メッセージ形式
            <select value={messageType} onChange={(e) => setMessageType(e.target.value as BroadcastMessageType)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 font-normal">
              <option value="text">文章</option>
              <option value="image">画像</option>
              <option value="quick_reply">クイック返信（高度な設定）</option>
              <option value="template">カード（高度な設定）</option>
            </select>
          </label>
        </div>

        <div className="mt-4">
          {messageType === 'text' && (
            <label className="text-sm font-medium text-gray-700">送信する文章
              <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 font-normal" placeholder="相手に送るDMを入力" />
            </label>
          )}
          {messageType === 'image' && (
            <label className="text-sm font-medium text-gray-700">画像URL
              <input value={content} onChange={(e) => setContent(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 font-normal" placeholder="https://..." />
            </label>
          )}
          {(messageType === 'template' || messageType === 'quick_reply') && (
            <label className="text-sm font-medium text-gray-700">メッセージ設定（JSON）
              <textarea value={advancedBody} onChange={(e) => setAdvancedBody(e.target.value)} rows={8} spellCheck={false} className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2.5 font-mono text-xs font-normal" placeholder={messageType === 'quick_reply' ? '{"text":"選んでください","quick_replies":[{"content_type":"text","title":"はい","payload":"YES"}]}' : '{"elements":[{"title":"タイトル","buttons":[]}]}' } />
            </label>
          )}
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <fieldset>
            <legend className="text-sm font-medium text-gray-700">送信対象</legend>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label><input type="radio" checked={audienceMode === 'all'} onChange={() => setAudienceMode('all')} className="mr-1.5" />登録済みの全対象者</label>
              <label><input type="radio" checked={audienceMode === 'tag'} onChange={() => setAudienceMode('tag')} className="mr-1.5" />タグで絞り込む</label>
            </div>
            {audienceMode === 'tag' && (
              <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm">
                <option value="">タグを選択</option>
                {tags.map((tag) => <option key={tag.id} value={String(tag.id)}>{tag.name}</option>)}
              </select>
            )}
            <p className="mt-2 text-xs text-gray-500">現在の対象人数：{audienceCount == null ? '未取得' : `${audienceCount}人`}</p>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-gray-700">保存方法</legend>
            <div className="mt-2 flex gap-4 text-sm">
              <label><input type="radio" checked={deliveryMode === 'draft'} onChange={() => setDeliveryMode('draft')} className="mr-1.5" />下書き</label>
              <label><input type="radio" checked={deliveryMode === 'schedule'} onChange={() => setDeliveryMode('schedule')} className="mr-1.5" />日時を予約</label>
            </div>
            {deliveryMode === 'schedule' && <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm" />}
          </fieldset>
        </div>

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={() => void save()} disabled={busy} className="min-h-11 rounded-lg px-5 text-sm font-medium text-white disabled:opacity-50" style={{ backgroundColor: ACCENT }}>{busy ? '処理中…' : editingId ? '変更を保存' : '保存する'}</button>
          {editingId && <button type="button" onClick={resetForm} className="min-h-11 rounded-lg border border-gray-300 px-4 text-sm">編集をやめる</button>}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">配信一覧</h2>
        {loading ? <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">読み込み中…</div> : items.length === 0 ? <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm text-gray-500">一斉配信はまだありません</div> : (
          <div className="space-y-3">
            {items.map((item) => {
              const badge = STATUS[item.status] ?? STATUS.draft
              const hasFailures = item.failureCount > 0 || Boolean(item.lastError)
              return (
                <article key={item.id} className="rounded-xl border border-gray-200 bg-white p-4">
                  <div className="flex flex-col justify-between gap-3 md:flex-row md:items-start">
                    <div>
                      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{item.name}</h3><span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.classes}`}>{badge.label}</span>{hasFailures && <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">要確認</span>}</div>
                      <p className="mt-1 text-xs text-gray-500">{item.messageType === 'text' ? '文章' : item.messageType === 'image' ? '画像' : '高度なメッセージ'} · {parseTagId(item.tagFilter) ? 'タグ指定' : '全対象者'}{item.scheduledAt ? ` · 予約 ${new Date(item.scheduledAt).toLocaleString('ja-JP')}` : ''}</p>
                      {item.status === 'sent' && <p className="mt-2 text-sm"><span className="text-green-700">成功 {item.successCount}件</span><span className="mx-2 text-gray-300">/</span><span className={item.failureCount ? 'text-red-700' : 'text-gray-500'}>失敗 {item.failureCount}件</span><span className="mx-2 text-gray-300">/</span>対象 {item.totalTarget}件</p>}
                      {item.lastError && <p className="mt-2 rounded bg-red-50 px-3 py-2 text-xs text-red-700">{item.lastError}</p>}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {(item.status === 'draft' || item.status === 'scheduled') && <button disabled={busy} onClick={() => beginEdit(item)} className="rounded-lg border border-gray-300 px-3 py-2 text-xs">編集</button>}
                      {(item.status === 'draft' || item.status === 'scheduled') && <button disabled={busy} onClick={() => void sendNow(item)} className="rounded-lg px-3 py-2 text-xs font-medium text-white disabled:opacity-50" style={{ backgroundColor: ACCENT }}>今すぐ送信</button>}
                      {item.status === 'sent' && <button onClick={() => void showResults(item.id)} className="rounded-lg border border-gray-300 px-3 py-2 text-xs">配信結果</button>}
                      {item.failureCount > 0 && <button onClick={() => void showResults(item.id, 'failed')} className="rounded-lg border border-red-300 px-3 py-2 text-xs text-red-700">失敗理由</button>}
                      {item.status !== 'sending' && <button disabled={busy} onClick={() => void remove(item)} className="rounded-lg px-3 py-2 text-xs text-gray-500 hover:bg-gray-100">削除</button>}
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {resultsFor !== null && (
        <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
          <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">配信結果：{selectedResult?.name}</h2><button onClick={() => { setResultsFor(null); setDeliveries([]) }} className="text-sm text-gray-500">閉じる</button></div>
          {resultsLoading ? <p className="text-sm text-gray-500">読み込み中…</p> : deliveries.length === 0 ? <p className="text-sm text-gray-500">表示する結果がありません</p> : (
            <div className="max-h-[420px] overflow-auto rounded-lg border border-gray-200">
              <table className="w-full text-left text-sm"><thead className="sticky top-0 bg-gray-50 text-xs text-gray-500"><tr><th className="px-3 py-2">送信先</th><th className="px-3 py-2">結果</th><th className="px-3 py-2">理由</th><th className="px-3 py-2">日時</th></tr></thead><tbody className="divide-y divide-gray-100">{deliveries.map((row) => <tr key={row.id}><td className="px-3 py-2">{row.displayName || row.username || `ID末尾 ${row.recipientHint}`}</td><td className={`px-3 py-2 font-medium ${row.status === 'success' ? 'text-green-700' : 'text-red-700'}`}>{row.status === 'success' ? '成功' : '失敗'}</td><td className="max-w-xl px-3 py-2 text-xs text-gray-700">{row.errorMessage || '—'}</td><td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">{new Date(row.attemptedAt).toLocaleString('ja-JP')}</td></tr>)}</tbody></table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
