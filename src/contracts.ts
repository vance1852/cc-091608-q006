export type SuggestedAction = "remeasure" | "contact-soon" | "seek-care-now";

export interface ValidatedDevice {
  deviceId: string;
  model: string;
  wearableKind: "wrist" | "cuff";
  calibratedAt: string;
  calibrationValidDays: number;
}

export interface BloodPressureSession {
  sessionId: string;
  patientId: string;
  gestationalWeek: number;
  deviceId: string;
  measuredAt: string;
  systolic: number;
  diastolic: number;
  rested: boolean;
  postureConfirmed: boolean;
  symptoms: string[];
}

export interface TriageOpinion {
  opinionId: string;
  sessionId: string;
  action: SuggestedAction;
  authorId: string;
  ruleVersion: string;
  createdAt: string;
  correctsOpinionId?: string;
}
