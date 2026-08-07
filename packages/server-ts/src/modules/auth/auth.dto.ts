import { z } from 'zod'

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
})

export const registerSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(6).max(128),
  display_name: z.string().min(1).max(128).optional(),
  displayName: z.string().min(1).max(128).optional(),
  email: z.string().email().optional(),
  code: z.string().min(4).max(8).optional(),
}).refine((v) => (v.email ? !!v.code : true), { message: 'code is required when email is provided' })

export const claimSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6).max(128),
})

export type LoginInput = z.infer<typeof loginSchema>
export type RegisterInput = z.infer<typeof registerSchema>
export type ClaimInput = z.infer<typeof claimSchema>
