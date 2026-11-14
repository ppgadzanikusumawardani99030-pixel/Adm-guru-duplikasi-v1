import type { AppStorageStateV5 } from '../types/storageV5';
import type { DocumentType, TeacherProfile } from '../types';
import type { DocumentGenerationContext, DocumentValidationResult } from './documentEngine/types';
import { validateDocumentRequirements } from './documentEngine';
import { isValidDocumentDate } from './documentDateService';
import { isQuotaExceededError, saveStorageV5, validateStorageStateV5 } from './storageV5';

export const PRODUCTION_MODE_STORAGE_KEY = 'administrasi_guru_production_mode_v1';

export type ProductionDocumentHealthStatus = 'SIAP_CETAK' | 'DATA_KURANG' | 'GAGAL_RENDER';

export interface ProductionDocumentAssessment {
  type: DocumentType;
  status: ProductionDocumentHealthStatus;
  label: 'Siap Cetak' | 'Data Kurang' | 'Gagal Render';
  reasons: string[];
  canDownload: boolean;
  validation: DocumentValidationResult;
}

export function getProductionMode(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(PRODUCTION_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setProductionMode(enabled: boolean): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    if (enabled) {
      localStorage.setItem(PRODUCTION_MODE_STORAGE_KEY, '1');
    } else {
      localStorage.removeItem(PRODUCTION_MODE_STORAGE_KEY);
    }
    return true;
  } catch (err) {
    if (isQuotaExceededError(err)) {
      return false;
    }
    return false;
  }
}

export function assessProductionDocumentStatus(
  type: DocumentType,
  context: Partial<DocumentGenerationContext>,
  renderError?: string
): ProductionDocumentAssessment {
  const productionContext: Partial<DocumentGenerationContext> = {
    ...context,
    productionMode: true,
  };
  const validation = validateDocumentRequirements(type, productionContext);

  if (renderError && renderError.trim()) {
    return {
      type,
      status: 'GAGAL_RENDER',
      label: 'Gagal Render',
      reasons: [renderError.trim()],
      canDownload: false,
      validation,
    };
  }

  if (!validation.isValid) {
    return {
      type,
      status: 'DATA_KURANG',
      label: 'Data Kurang',
      reasons: validation.missingFields.length > 0
        ? validation.missingFields
        : [validation.message || 'Data dokumen belum lengkap.'],
      canDownload: false,
      validation,
    };
  }

  return {
    type,
    status: 'SIAP_CETAK',
    label: 'Siap Cetak',
    reasons: [],
    canDownload: true,
    validation,
  };
}

export interface DestinationIdentityUpdateInput {
  profileId: string;
  schoolId: string;
  workspaceId?: string;
  teacherName?: string;
  teacherNip?: string;
  teacherNuptk?: string;
  teacherStatus?: TeacherProfile['status'];
  schoolName?: string;
  schoolNpsn?: string;
  schoolAddress?: string;
  schoolVillage?: string;
  schoolDistrict?: string;
  schoolRegency?: string;
  schoolProvince?: string;
  principalName?: string;
  principalNip?: string;
  documentDate?: string;
}

/**
 * Updates destination teacher, school, principal, and documentDate metadata ONLY.
 * Leaves CP, TP, ATP, Bab/Materi, LearningPlans, AssessmentPackages, Calendars, and Lineage untouched.
 */
export function updateDestinationIdentityOnly(
  current: AppStorageStateV5,
  input: DestinationIdentityUpdateInput,
  persist: (state: AppStorageStateV5) => void = saveStorageV5
): { state: AppStorageStateV5; persisted: boolean; quotaError?: string } {
  const next: AppStorageStateV5 = JSON.parse(JSON.stringify(current));
  const now = new Date().toISOString();

  const profileIdx = next.profiles.findIndex((p) => p.id === input.profileId);
  if (profileIdx === -1) {
    throw new Error('Profil guru tujuan tidak ditemukan.');
  }
  const schoolIdx = next.schools.findIndex((s) => s.id === input.schoolId);
  if (schoolIdx === -1) {
    throw new Error('Sekolah tujuan tidak ditemukan.');
  }

  const profile = next.profiles[profileIdx];
  if (input.teacherName !== undefined) profile.name = input.teacherName.trim();
  if (input.teacherNip !== undefined) profile.nip = input.teacherNip.trim();
  if (input.teacherNuptk !== undefined) profile.nuptk = input.teacherNuptk.trim();
  if (input.teacherStatus !== undefined) profile.status = input.teacherStatus;
  profile.updatedAt = now;

  const school = next.schools[schoolIdx];
  if (input.schoolName !== undefined) school.name = input.schoolName.trim();
  if (input.schoolNpsn !== undefined) school.npsn = input.schoolNpsn.trim();
  if (input.schoolAddress !== undefined) school.address = input.schoolAddress.trim();
  if (input.schoolVillage !== undefined) school.village = input.schoolVillage.trim();
  if (input.schoolDistrict !== undefined) school.district = input.schoolDistrict.trim();
  if (input.schoolRegency !== undefined) school.regency = input.schoolRegency.trim();
  if (input.schoolProvince !== undefined) school.province = input.schoolProvince.trim();
  if (input.principalName !== undefined) school.principalName = input.principalName.trim();
  if (input.principalNip !== undefined) school.principalNip = input.principalNip.trim();
  if (Array.isArray(next.principalHistories)) {
    const histIdx = next.principalHistories.findIndex((h) => h.schoolId === school.id && h.isActive);
    if (histIdx !== -1) {
      if (input.principalName !== undefined) next.principalHistories[histIdx].name = school.principalName;
      if (input.principalNip !== undefined) next.principalHistories[histIdx].nip = school.principalNip;
    }
  }
  school.updatedAt = now;

  if (input.documentDate !== undefined) {
    if (!isValidDocumentDate(input.documentDate)) {
      throw new Error('Tanggal dokumen tujuan harus berformat YYYY-MM-DD yang valid.');
    }
    const ws = next.workspaces.find((w) => w.id === (input.workspaceId || next.activeWorkspaceId));
    if (ws) {
      ws.documentDate = input.documentDate;
      ws.updatedAt = now;
    }
  }

  const validated = validateStorageStateV5(next);
  try {
    persist(validated);
    return { state: validated, persisted: true };
  } catch (err) {
    if (isQuotaExceededError(err)) {
      return {
        state: validated,
        persisted: false,
        quotaError: err instanceof Error ? err.message : 'Penyimpanan browser (localStorage) penuh. Perubahan berlaku di sesi aktif.',
      };
    }
    throw err;
  }
}
