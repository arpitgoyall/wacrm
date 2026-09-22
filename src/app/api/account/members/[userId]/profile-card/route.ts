import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'

const MAX_BYTES = 2 * 1024 * 1024
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

async function authorize(userId: string) {
  const ctx = await requireRole('admin')
  const db = supabaseAdmin()
  const { data: member } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', ctx.accountId)
    .eq('user_id', userId)
    .maybeSingle()
  return { ctx, db, member }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const { userId } = await params
    const { ctx, db, member } = await authorize(userId)
    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })

    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Image file is required' }, { status: 400 })
    }
    if (!ALLOWED.has(file.type) || file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'Use a PNG, JPG, WebP, or GIF up to 2 MB' }, { status: 400 })
    }

    const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
    const path = `${userId}/profile-card-${Date.now()}.${ext}`
    const { error: uploadError } = await db.storage
      .from('avatars')
      .upload(path, file, { contentType: file.type, cacheControl: '3600', upsert: true })
    if (uploadError) throw uploadError
    const { data: { publicUrl } } = db.storage.from('avatars').getPublicUrl(path)

    const { error: updateError } = await db
      .from('profiles')
      .update({ profile_card: publicUrl })
      .eq('account_id', ctx.accountId)
      .eq('user_id', userId)
    if (updateError) throw updateError
    return NextResponse.json({ profile_card: publicUrl })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const { userId } = await params
    const { ctx, db, member } = await authorize(userId)
    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 })
    const { error } = await db
      .from('profiles')
      .update({ profile_card: null })
      .eq('account_id', ctx.accountId)
      .eq('user_id', userId)
    if (error) throw error
    return NextResponse.json({ profile_card: null })
  } catch (err) {
    return toErrorResponse(err)
  }
}
