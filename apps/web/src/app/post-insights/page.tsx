'use client'

import { useEffect, useMemo, useState } from 'react'
import { postInsightsApi, type PostInsightSnapshotApi } from '@/lib/api'

const TYPE_LABEL: Record<PostInsightSnapshotApi['postType'], string> = {
  feed_image: 'フィード',
  carousel: 'カルーセル',
  reel: 'リール',
  story: 'ストーリー',
}

const COLUMNS: Array<{
  key: keyof Pick<
    PostInsightSnapshotApi,
    'views' | 'reach' | 'likes' | 'comments' | 'saved' | 'shares' |
    'profileVisits' | 'follows' | 'avgWatchTimeMs'
  >
  label: string
}> = [
  { key: 'views', label: '閲覧' },
  { key: 'reach', label: 'リーチ' },
  { key: 'likes', label: 'いいね' },
  { key: 'comments', label: 'コメント' },
  { key: 'saved', label: '保存' },
  { key: 'shares', label: 'シェア' },
  { key: 'profileVisits', label: 'プロフアクセス' },
  { key: 'follows', label: 'フォロー' },
  { key: 'avgWatchTimeMs', label: '平均再生時間' },
]

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value))
}

function formatValue(key: string, value: number | null): string {
  if (value === null) return '対象外'
  if (key === 'avgWatchTimeMs') return `${(value / 1000).toFixed(1)}秒`
  return value.toLocaleString('ja-JP')
}

export default function PostInsightsPage() {
  const [rows, setRows] = useState<PostInsightSnapshotApi[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    postInsightsApi.list()
      .then(setRows)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false))
  }, [])

  const groups = useMemo(() => {
    const grouped = new Map<string, PostInsightSnapshotApi[]>()
    for (const row of rows) {
      const current = grouped.get(row.mediaPostId) ?? []
      current.push(row)
      grouped.set(row.mediaPostId, current)
    }
    return [...grouped.values()].map((items) =>
      items.sort((a, b) => a.checkpointHours - b.checkpointHours)
    )
  }, [rows])

  return (
    <div className="mx-auto max-w-[1500px] space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">投稿分析</h1>
        <p className="mt-1 text-sm text-gray-500">
          機能追加後にIG Harnessから公開した投稿を、24時間ごとに7日間自動計測します。
        </p>
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
        Instagramが投稿形式ごとに提供していない数値は「対象外」と表示します。0とは異なります。
      </div>

      {loading && <div className="rounded-xl border bg-white p-8 text-center text-gray-500">読み込み中…</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-red-700">{error}</div>}
      {!loading && !error && groups.length === 0 && (
        <div className="rounded-xl border bg-white p-10 text-center">
          <p className="font-medium text-gray-700">計測済みの投稿はまだありません</p>
          <p className="mt-2 text-sm text-gray-500">新しい投稿の公開から24時間後に最初の数値が表示されます。</p>
        </div>
      )}

      {groups.map((items) => {
        const first = items[0]
        const title = first.postTitle || first.postCaption?.slice(0, 60) || `投稿 ${first.instagramMediaId}`
        return (
          <section key={first.mediaPostId} className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="truncate font-semibold text-gray-900">{title}</h2>
                  <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                    {TYPE_LABEL[first.postType]}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500">公開：{formatDate(first.publishedAt)}</p>
              </div>
              <span className="text-xs text-gray-500">{items.length}/7回取得済み</span>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-[1050px] w-full text-sm">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="whitespace-nowrap px-4 py-3 text-left">計測時点</th>
                    {COLUMNS.map((column) => (
                      <th key={column.key} className="whitespace-nowrap px-3 py-3 text-right">{column.label}</th>
                    ))}
                    <th className="whitespace-nowrap px-4 py-3 text-right">取得日時</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="whitespace-nowrap px-4 py-3 font-medium text-gray-800">
                        {row.checkpointHours / 24}日後
                      </td>
                      {COLUMNS.map((column) => (
                        <td
                          key={column.key}
                          className={`whitespace-nowrap px-3 py-3 text-right ${row[column.key] === null ? 'text-gray-400' : 'text-gray-800'}`}
                        >
                          {formatValue(column.key, row[column.key])}
                        </td>
                      ))}
                      <td className="whitespace-nowrap px-4 py-3 text-right text-xs text-gray-500">
                        {formatDate(row.capturedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )
      })}
    </div>
  )
}
