import { Schema, model, InferSchemaType, Types } from 'mongoose';

export const ROLES = ['ADMIN', 'USER'] as const;
export type Role = (typeof ROLES)[number];
export const USER_STATUSES = ['INVITED', 'ACTIVE', 'INACTIVE'] as const;

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    username: { type: String, required: true, trim: true, maxlength: 64 },
    usernameNormalized: { type: String, required: true },
    phone: { type: String, default: null },
    passwordHash: { type: String, default: null, select: false },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'INVITED' },
    mustChangePassword: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'users' },
);

userSchema.index({ usernameNormalized: 1 }, { unique: true });
userSchema.index({ role: 1, status: 1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model('User', userSchema);

export function normalizeUsername(u: string): string {
  return u.trim().toLowerCase();
}

/** Safe projection for API responses. Never includes passwordHash. */
export function toSafeUser(u: Pick<UserDoc, '_id' | 'name' | 'username' | 'phone' | 'role' | 'status' | 'mustChangePassword' | 'createdAt' | 'updatedAt' | 'version'>) {
  return {
    id: String(u._id),
    name: u.name,
    username: u.username,
    phone: u.phone ?? null,
    role: u.role,
    status: u.status,
    mustChangePassword: u.mustChangePassword,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    version: u.version,
  };
}
