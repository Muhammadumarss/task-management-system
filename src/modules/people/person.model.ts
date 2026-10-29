import { Schema, model, InferSchemaType, Types } from 'mongoose';

const locationSchema = new Schema(
  {
    addressText: { type: String, default: null },
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },
  },
  { _id: false },
);

const personSchema = new Schema(
  {
    name: { type: String, required: true },
    phoneOriginal: { type: String, required: true },
    phoneNormalized: { type: String, required: true },
    requestedWorkDate: { type: String, required: true }, // YYYY-MM-DD, business timezone
    location: { type: locationSchema, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    creatorRole: { type: String, enum: ['ADMIN', 'USER'], required: true },
    // Authorization boundary only. NEVER put a TTL index on this field.
    editableUntil: { type: Date, required: true },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
    // Admin-only signal: another record shares this phone number.
    possibleDuplicate: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    // Touched whenever a task is created so archive/task-create transactions conflict instead of write-skewing.
    taskLockAt: { type: Date, default: null },
    version: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false, collection: 'people' },
);

personSchema.index({ createdBy: 1, editableUntil: 1 });
personSchema.index({ phoneNormalized: 1 });
personSchema.index({ status: 1, createdAt: -1 });

export type PersonDoc = InferSchemaType<typeof personSchema> & { _id: Types.ObjectId };
export const Person = model('Person', personSchema);
