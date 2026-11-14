import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { inflateSync } from 'node:zlib';
import { createTwoSemesterAdministrationImportFixture } from './fixtures/readyAdministrationImportFixture';
import { documentZipHarness } from './fixtures/documentZipHarness';
import { createCompleteProjectZip, readCompleteProjectZip } from '../src/services/completeProjectZipService';
import { prepareCompleteAdministrationProjectImport } from '../src/services/administrationProjectImportService';
import { buildImportedProjectExportContext } from '../src/services/identityOnlyProjectExport';
import {
  assessProductionDocumentStatus,
  getProductionMode,
  setProductionMode,
  updateDestinationIdentityOnly,
} from '../src/services/productionModeService';
import { getRuntimeContextV5 } from '../src/services/runtimeV5';
import {
  generateDocument,
  generatePdfDocument,
  validateDocumentRequirements,
} from '../src/services/documentEngine';
import { createDocumentSnapshot, resolveEffectiveContext } from '../src/services/documentEngine/snapshot';
import { prepareModulAjarExportContext } from '../src/services/documentEngine/modulAjarExportContext';
import { STORAGE_KEY_V5, StorageQuotaExceededError, isQuotaExceededError, parseBackupV5, saveStorageV5, serializeBackupV5 } from '../src/services/storageV5';
import { readFileSync } from 'node:fs';
import { evaluateExpression, initializer } from './helpers/uiContractHarness';

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function decodePdfStreams(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  let out = raw;
  const regex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    try {
      const chunk = Buffer.from(match[1], 'latin1');
      out += '\n' + inflateSync(chunk).toString('latin1');
    } catch {
      // Ignore non-flate streams
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Setup in-memory localStorage mock
// ---------------------------------------------------------------------------
const memory = new Map<string, string>();
let simulateQuotaExceeded = false;
(globalThis as any).localStorage = {
  getItem: (k: string) => memory.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (simulateQuotaExceeded) {
      const err: any = new Error('QuotaExceededError: storage limit reached');
      err.name = 'QuotaExceededError';
      err.code = 22;
      throw err;
    }
    memory.set(k, v);
  },
  removeItem: (k: string) => {
    memory.delete(k);
  },
  clear: () => memory.clear(),
};

// Build source fixture where CP, TP, ATP, LearningPlan, AssessmentPackage are DRAFT and Calendar is UNRESOLVED
const source = createTwoSemesterAdministrationImportFixture();
source.annualData.cp[0].value.workflowStatus = 'DRAFT';
source.annualData.cpAnalysis[0].value.workflowStatus = 'DRAFT';
source.annualData.tp[0].value.workflowStatus = 'DRAFT';
source.annualData.atp[0].value.workflowStatus = 'DRAFT';
for (const entry of source.semesterData.learningPlan) {
  for (const plan of entry.value) {
    plan.status = 'DRAFT';
    plan.confirmedAt = undefined;
  }
}
for (const entry of source.semesterData.assessmentPlan) {
  for (const plan of entry.value) {
    plan.workflowStatus = 'DRAFT';
    plan.needsReview = true;
  }
}
for (const entry of source.semesterData.assessmentPackage) {
  for (const pkg of entry.value) {
    pkg.workflowStatus = 'DRAFT';
    pkg.needsReview = true;
  }
}
for (const entry of source.semesterData.academicCalendar) {
  entry.value.calendar.workflowStatus = 'UNRESOLVED';
  entry.value.calendar.confirmedAt = undefined;
}
// Ensure remedial record exists for full ready baseline test
source.semesterData.remedial = [
  {
    semesterPlanId: 'sp1',
    value: [
      {
        id: 'rem-1',
        studentId: 'student',
        tpId: 't',
        reason: 'Perlu penguatan lempar bola',
        intervention: 'Latihan terbimbing',
        reassessmentScore: 80,
      } as any,
    ],
  },
];

const sourceTPBefore = JSON.stringify(source.annualData.tp[0].value.items.map((i) => ({ code: i.code, statement: i.statement })));
const sourceUnitsBefore = JSON.stringify(
  source.annualData.atpUnitMappings![0].value.units.map((u) => ({
    title: u.title,
    materials: u.materials.map((m) => m.title),
  }))
);

const zipBytes = await createCompleteProjectZip(source, 'y');
const archive = await readCompleteProjectZip(zipBytes);

memory.set(STORAGE_KEY_V5, JSON.stringify(source));
setProductionMode(true);
assert.equal(getProductionMode(), true);

// ---------------------------------------------------------------------------
// 1. Impor master dengan status DRAFT & kalender UNRESOLVED -> langsung Pusat Dokumen
// ---------------------------------------------------------------------------
const imported = prepareCompleteAdministrationProjectImport(source, archive, {
  mode: 'IDENTITY_ONLY',
  targetProfileId: 'p2',
  targetSchoolId: 's2',
  documentDate: '2026-10-28',
  productionMode: true,
  preserveFactualData: true,
});

assert.equal(imported.nextStep, 'admin', 'Production mode must route directly to Pusat Dokumen (admin)');
const importedYear = imported.state.yearPlans.find((y) => y.id === imported.yearPlanId)!;
assert.equal(importedYear.identityOnlyImport?.timingIsSourceReference, false);
assert.equal(importedYear.identityOnlyImport?.factualDataExcluded, false);

const importedTp = imported.state.annualData.tp.find((e) => e.yearPlanId === imported.yearPlanId)!.value;
assert.equal(importedTp.workflowStatus, 'DRAFT', 'Must preserve DRAFT status without faking SIAP');
assert.equal(
  JSON.stringify(importedTp.items.map((i) => ({ code: i.code, statement: i.statement }))),
  sourceTPBefore,
  'TP substance must remain unchanged after production import'
);

const importedMapping = imported.state.annualData.atpUnitMappings!.find((e) => e.yearPlanId === imported.yearPlanId)!.value;
assert.equal(
  JSON.stringify(importedMapping.units.map((u) => ({ title: u.title, materials: u.materials.map((m) => m.title) }))),
  sourceUnitsBefore,
  'Bab & Lingkup Materi must remain unchanged'
);

const importedPlan = imported.state.semesterData.learningPlan.find((e) =>
  imported.state.semesterPlans.some((sp) => sp.yearPlanId === imported.yearPlanId && sp.id === e.semesterPlanId && sp.semester === 1)
)!.value[0];
assert.equal(importedPlan.status, 'DRAFT', 'LearningPlan DRAFT status must stay DRAFT');

const runtime = getRuntimeContextV5(imported.state);
assert.equal(runtime.activeYearPlan?.id, imported.yearPlanId);
assert.equal(runtime.activeSemesterPlan?.semester, 1, 'Production mode defaults active semester to Semester 1');

// ---------------------------------------------------------------------------
// 2. Preview & unduh dokumen lengkap (DOCX & PDF) tanpa AI atau konfirmasi step
// ---------------------------------------------------------------------------
const baseExportCtx = buildImportedProjectExportContext(imported.state, imported.yearPlanId);
const prodCtx = { ...baseExportCtx, productionMode: true };

for (const docType of ['CP', 'TP', 'ATP', 'PROTA', 'PROMES', 'MODUL_AJAR', 'ASESMEN', 'KKTP', 'DAFTAR_HADIR', 'KALENDER_AKADEMIK', 'REMEDIAL_PENGAYAAN'] as const) {
  const status = assessProductionDocumentStatus(docType, prodCtx);
  assert.equal(status.status, 'SIAP_CETAK', `${docType} should be SIAP_CETAK in production mode, got: ${status.reasons.join('; ')}`);
  assert.equal(status.canDownload, true);
}

for (const docType of ['TP', 'PROTA', 'PROMES', 'MODUL_AJAR', 'ASESMEN', 'DAFTAR_HADIR'] as const) {
  const docxRes = await generateDocument(docType, { ...prodCtx, skipDownload: true });
  assert(docxRes.blob && docxRes.blob.size > 0, `${docType} DOCX must generate non-empty blob`);
  const pdfRes = await generatePdfDocument(docType, { ...prodCtx, skipDownload: true });
  assert(pdfRes.blob && pdfRes.blob.size > 0, `${docType} PDF must generate non-empty blob`);
}

// ---------------------------------------------------------------------------
// 3. Dokumen tidak lengkap diblokir individual dengan alasan jelas, sementara yang valid tetap Siap Cetak
// ---------------------------------------------------------------------------
const partialCtx = {
  ...prodCtx,
  students: [],
  remedials: [],
  enrichments: [],
  calendar: undefined,
};

const daftarHadirStatus = assessProductionDocumentStatus('DAFTAR_HADIR', partialCtx);
assert.equal(daftarHadirStatus.status, 'DATA_KURANG');
assert.equal(daftarHadirStatus.canDownload, false);
assert(daftarHadirStatus.reasons.some((r) => /siswa/i.test(r)), 'DAFTAR_HADIR reason must explain missing students');

const remedialStatus = assessProductionDocumentStatus('REMEDIAL_PENGAYAAN', partialCtx);
assert.equal(remedialStatus.status, 'DATA_KURANG');
assert.equal(remedialStatus.canDownload, false);
assert(remedialStatus.reasons.some((r) => /remedial|pengayaan/i.test(r)));

const kalenderStatus = assessProductionDocumentStatus('KALENDER_AKADEMIK', partialCtx);
assert.equal(kalenderStatus.status, 'DATA_KURANG');
assert.equal(kalenderStatus.canDownload, false);

const renderErrorStatus = assessProductionDocumentStatus('TP', partialCtx, 'Renderer crash test');
assert.equal(renderErrorStatus.status, 'GAGAL_RENDER');
assert.equal(renderErrorStatus.label, 'Gagal Render');
assert.equal(renderErrorStatus.canDownload, false);
assert.deepEqual(renderErrorStatus.reasons, ['Renderer crash test']);

// Complete docs stay downloadable despite sibling Data Kurang docs
const tpPartialStatus = assessProductionDocumentStatus('TP', partialCtx);
assert.equal(tpPartialStatus.status, 'SIAP_CETAK');
assert.equal(tpPartialStatus.canDownload, true);
const tpDocx = await generateDocument('TP', { ...partialCtx, skipDownload: true });
assert(tpDocx.blob && tpDocx.blob.size > 0);

// ---------------------------------------------------------------------------
// 4. Ganti identitas tujuan -> seluruh dokumen pakai identitas baru, substansi utuh
// ---------------------------------------------------------------------------
const swapped = updateDestinationIdentityOnly(imported.state, {
  profileId: 'p2',
  schoolId: 's2',
  workspaceId: imported.state.activeWorkspaceId,
  teacherName: 'BU SITI AMINAH, S.Pd',
  teacherNip: '198805052010012009',
  schoolName: 'SDN HARAPAN BANGSA 09',
  schoolNpsn: '20209999',
  schoolAddress: 'Jl. Merdeka Belajar No. 99',
  principalName: 'H. AHMAD DAHLAN, M.Pd',
  principalNip: '197001011995121001',
  documentDate: '2026-11-15',
});
assert.equal(swapped.persisted, true);

const swappedTp = swapped.state.annualData.tp.find((e) => e.yearPlanId === imported.yearPlanId)!.value;
assert.equal(
  JSON.stringify(swappedTp.items.map((i) => ({ code: i.code, statement: i.statement }))),
  sourceTPBefore,
  'Swapping identity must never alter TP substance'
);

const swappedCtx = {
  ...buildImportedProjectExportContext(swapped.state, imported.yearPlanId),
  productionMode: true,
  skipDownload: true,
};

for (const docType of ['MODUL_AJAR', 'PROTA', 'ASESMEN'] as const) {
  const docOut = await generateDocument(docType, swappedCtx);
  const xml = await (await JSZip.loadAsync(await blobBytes(docOut.blob!))).file('word/document.xml')!.async('string');
  assert(xml.includes('BU SITI AMINAH, S.Pd'), `${docType} DOCX must use destination teacher name`);
  assert(xml.includes('SDN HARAPAN BANGSA 09'), `${docType} DOCX must use destination school name`);
  assert(xml.includes('H. AHMAD DAHLAN, M.Pd'), `${docType} DOCX must use destination principal name`);
  assert(!xml.includes('GURU_ASAL_TEST'), `${docType} DOCX must NOT leak source teacher`);
  assert(!xml.includes('SEKOLAH_ASAL_TEST'), `${docType} DOCX must NOT leak source school`);
  assert(!xml.includes('KEPSEK_ASAL_TEST'), `${docType} DOCX must NOT leak source principal`);
}

const modulPdf = await generatePdfDocument('MODUL_AJAR', swappedCtx);
const pdfText = decodePdfStreams(await blobBytes(modulPdf.blob));
assert(pdfText.includes('BU SITI AMINAH, S.Pd') || pdfText.includes('SDN HARAPAN BANGSA 09'), 'PDF output must contain destination identity');
assert(!pdfText.includes('GURU_ASAL_TEST') && !pdfText.includes('SEKOLAH_ASAL_TEST'), 'PDF output must not leak source identity');

// ---------------------------------------------------------------------------
// 5. Unduh ZIP PDF+DOCX tepat sekali (1 download) dengan laporan berhasil/gagal
// ---------------------------------------------------------------------------
const zipHarness = documentZipHarness();
const zipState = structuredClone(swapped.state);
// Remove roster from Semester 1 & 2 to test partial reporting (some SKIPPED, others SUCCESS)
zipState.semesterData.roster = zipState.semesterData.roster.map((e) => ({ ...e, value: [] }));
const zipCtx = {
  ...buildImportedProjectExportContext(zipState, imported.yearPlanId),
  productionMode: true,
  skipDownload: false,
};

const zipResult = await zipHarness.generateZipBundle(
  {
    types: ['TP', 'MODUL_AJAR', 'ASESMEN', 'DAFTAR_HADIR'],
    format: 'both',
    documentMode: 'data',
  },
  zipCtx
);

assert.equal(zipHarness.downloads.length, 1, 'ZIP download handler must trigger saveAs exact once');
assert(zipResult.zipBlob && zipResult.zipBlob.size > 0, 'zipBlob must be non-empty');
assert((zipResult.successCount || 0) >= 3, 'Valid docs (TP, MODUL_AJAR, ASESMEN) must succeed in ZIP');
assert((zipResult.skippedCount || 0) >= 1, 'Incomplete DAFTAR_HADIR must be reported as SKIPPED with reason');
assert(
  zipResult.itemResults!.some((item) => item.type === 'DAFTAR_HADIR' && item.status === 'SKIPPED' && item.reason),
  'SKIPPED item must include clear reason'
);

const parsedZip = await JSZip.loadAsync(await blobBytes(zipHarness.downloads[0].blob));
const zipPaths = Object.keys(parsedZip.files);
assert(zipPaths.some((p) => p.endsWith('.pdf')));
assert(zipPaths.some((p) => p.endsWith('.docx')));

// ---------------------------------------------------------------------------
// 6. Uji QuotaExceededError (tidak menghapus data user) & Regresi Mode Normal V22
// ---------------------------------------------------------------------------
memory.set('user_precious_data', 'DO_NOT_DELETE_THIS');
simulateQuotaExceeded = true;

let caughtQuota = false;
try {
  saveStorageV5(swapped.state);
} catch (err) {
  caughtQuota = err instanceof StorageQuotaExceededError && isQuotaExceededError(err);
}
assert.equal(caughtQuota, true, 'saveStorageV5 must throw StorageQuotaExceededError on quota overflow');
assert.equal(memory.get('user_precious_data'), 'DO_NOT_DELETE_THIS', 'QuotaExceededError must NEVER delete existing user data');

const inMemorySwap = updateDestinationIdentityOnly(swapped.state, {
  profileId: 'p2',
  schoolId: 's2',
  workspaceId: swapped.state.activeWorkspaceId,
  teacherName: 'PAK DARMAWAN, S.Pd',
});
assert.equal(inMemorySwap.persisted, false);
assert(inMemorySwap.quotaError && inMemorySwap.quotaError.length > 0);
assert.equal(memory.get('user_precious_data'), 'DO_NOT_DELETE_THIS');
assert.equal(getRuntimeContextV5(inMemorySwap.state).activeProfile?.name, 'PAK DARMAWAN, S.Pd');

simulateQuotaExceeded = false;

// Regresi Mode Normal V22: KKTP (TP DRAFT), PROMES (Kalender UNRESOLVED), MODUL_AJAR (LearningPlan DRAFT), ASESMEN (AssessmentPackage DRAFT) tetap diblokir saat productionMode = false
const normalModeCtx = { ...baseExportCtx, productionMode: false };
assert.equal(validateDocumentRequirements('KKTP', normalModeCtx).isValid, false, 'Normal V22 KKTP must still require SIAP TP/KKTP');
assert.equal(validateDocumentRequirements('PROMES', normalModeCtx).isValid, false, 'Normal V22 PROMES must still require CONFIRMED calendar');
assert.equal(validateDocumentRequirements('MODUL_AJAR', normalModeCtx).isValid, false, 'Normal V22 must still require SIAP LearningPlan');
assert.equal(validateDocumentRequirements('ASESMEN', normalModeCtx).isValid, false, 'Normal V22 must still require SIAP AssessmentPackage');

const normalImport = prepareCompleteAdministrationProjectImport(source, archive, {
  mode: 'IDENTITY_ONLY',
  targetProfileId: 'p2',
  targetSchoolId: 's2',
  documentDate: '2026-10-28',
  productionMode: false,
});
assert.notEqual(normalImport.nextStep, 'admin', 'Normal V22 import of DRAFT project must still route through authoring steps');

// ---------------------------------------------------------------------------
// 7. Uji Proyek Besar (20 TP, 40 siswa, 20 sesi presensi, multi-asesmen)
// ---------------------------------------------------------------------------
const largeSource = structuredClone(source);
const baseTpItem = largeSource.annualData.tp[0].value.items[0];
const baseAtpItem = largeSource.annualData.atp[0].value.items[0];
for (let i = 1; i <= 18; i++) {
  const tpId = `tp-bulk-${i}`;
  largeSource.annualData.tp[0].value.items.push({
    ...structuredClone(baseTpItem),
    id: tpId,
    code: `TP.B.${i}`,
    statement: `Menganalisis dan mempraktikkan variasi gerak kompleks level ${i} dalam aktivitas olahraga beregu maupun perorangan secara terukur dan sportif.`,
    contentScope: `Materi Kompleks Bab ${i}`,
  });
  largeSource.annualData.atp[0].value.items.push({
    ...structuredClone(baseAtpItem),
    id: `atp-bulk-${i}`,
    stepNumber: i + 2,
    tpId,
    materialScope: `Materi Kompleks Bab ${i}`,
    jp: 2,
  });
}
for (const rosterEntry of largeSource.semesterData.roster) {
  for (let s = 2; s <= 40; s++) {
    rosterEntry.value.push({
      id: `${rosterEntry.semesterPlanId}-stu-${s}`,
      academicSettingId: rosterEntry.semesterPlanId,
      name: `Peserta Didik Uji Nomor ${String(s).padStart(2, '0')}`,
      nisn: `0099${String(s).padStart(6, '0')}`,
    } as any);
  }
}
for (const attEntry of largeSource.semesterData.attendance) {
  for (let m = 2; m <= 20; m++) {
    attEntry.value.sessions.push({
      id: `${attEntry.semesterPlanId}-sess-${m}`,
      academicSettingId: attEntry.semesterPlanId,
      date: `2026-08-${String(Math.min(28, m + 3)).padStart(2, '0')}`,
      meetingNumber: m,
      createdAt: '2026-01-01T00:00:00Z',
    });
  }
}
for (const pkgEntry of largeSource.semesterData.assessmentPackage) {
  const basePkg = pkgEntry.value[0];
  pkgEntry.value.push({
    ...structuredClone(basePkg),
    id: `${basePkg.id}-extra`,
    title: `${basePkg.title} Tambahan`,
    workflowStatus: 'DRAFT',
    needsReview: true,
  });
}

const largeZipBytes = await createCompleteProjectZip(largeSource, 'y');
const largeArchive = await readCompleteProjectZip(largeZipBytes);
memory.set(STORAGE_KEY_V5, JSON.stringify(largeSource));
const largeImported = prepareCompleteAdministrationProjectImport(largeSource, largeArchive, {
  mode: 'IDENTITY_ONLY',
  targetProfileId: 'p2',
  targetSchoolId: 's2',
  documentDate: '2026-11-20',
  productionMode: true,
  preserveFactualData: true,
});
assert.equal(largeImported.nextStep, 'admin');

const docsBeforeLargeZip = largeImported.state.documents.length;
const largeZipHarness = documentZipHarness();
const largeCtx = {
  ...buildImportedProjectExportContext(largeImported.state, largeImported.yearPlanId),
  productionMode: true,
  skipDownload: false,
};
const largeZipResult = await largeZipHarness.generateZipBundle(
  { format: 'both', documentMode: 'data' },
  largeCtx
);
assert.equal(largeZipHarness.downloads.length, 1, 'Large project ZIP must trigger exactly 1 download');
assert(largeZipResult.zipBlob && largeZipResult.zipBlob.size > 10000, 'Large project ZIP must be substantial and non-empty');
assert((largeZipResult.successCount || 0) >= 10, `Large project must export >=10 items, got ${largeZipResult.successCount}`);
assert.equal(largeImported.state.documents.length, docsBeforeLargeZip, 'Production ZIP export must not bloat state.documents');

// ---------------------------------------------------------------------------
// 8. Regresi: Production Mode single download abaikan snapshot lama & cadangan memori saat quota penuh
// ---------------------------------------------------------------------------
const staleSnapshot = createDocumentSnapshot(
  {
    ...swappedCtx,
    profile: { ...swappedCtx.profile, name: 'GURU_ASAL_TEST', nip: '0000' },
    school: { ...swappedCtx.school, name: 'SEKOLAH_ASAL_TEST', principalName: 'KEPSEK_ASAL_TEST' },
  },
  'docx',
  'data',
  'PROTA'
);
const singleDownloads: { blob: Blob; fileName: string }[] = [];
const singleHandler = evaluateExpression(
  initializer('src/components/AdminDocsExport.tsx', 'handleGenerateSingleDoc'),
  {
    context: swappedCtx,
    academicSetting: swappedCtx.academicSetting,
    workspace: swappedCtx.workspace,
    documentMode: 'data',
    productionMode: true,
    localDocs: [],
    historicalModulSnapshot: staleSnapshot,
    getDocRecord: () => ({ id: 'doc-stale', type: 'PROTA', snapshot: staleSnapshot }),
    prepareModulAjarExportContext,
    resolveEffectiveContext,
    createDocumentSnapshot,
    validateDocumentRequirements,
    generateDocument: async (_type: any, ctx: any) => generateDocument(_type, { ...ctx, skipDownload: true }),
    generatePdfDocument,
    saveAs: (blob: Blob, fileName: string) => singleDownloads.push({ blob, fileName }),
    setGeneratingDocType: () => {},
    setExportErrorMessage: (m: string | null) => { if (m) assert.fail(m); },
    setExportSuccessMessage: () => {},
    setRenderErrorsByType: () => {},
    setLocalDocs: () => {},
    onUpdateDocuments: undefined,
    formatOfficialSnapshotDate: (v: string) => v,
    setTimeout: () => 0,
  }
);
await singleHandler('PROTA', 'pdf');
assert.equal(singleDownloads.length, 1);
const singlePdfText = decodePdfStreams(await blobBytes(singleDownloads[0].blob));
assert(singlePdfText.includes('BU SITI AMINAH, S.Pd') || singlePdfText.includes('SDN HARAPAN BANGSA 09'), 'Production single download must use swapped destination identity');
assert(!singlePdfText.includes('GURU_ASAL_TEST') && !singlePdfText.includes('SEKOLAH_ASAL_TEST'), 'Production single download must NEVER leak stale imported snapshot identity');

// In-memory backup ZIP & JSON when localStorage is full
simulateQuotaExceeded = true;
memory.set('user_precious_data', 'DO_NOT_DELETE_THIS');
const backupZipBytes = await createCompleteProjectZip(inMemorySwap.state, imported.yearPlanId);
const parsedBackupArchive = await readCompleteProjectZip(backupZipBytes);
assert.equal(parsedBackupArchive.project.profiles[0].name, 'PAK DARMAWAN, S.Pd', 'In-memory ZIP backup must preserve swapped session identity');
const backupJson = serializeBackupV5(inMemorySwap.state);
const parsedBackupState = parseBackupV5(backupJson);
assert.equal(parsedBackupState.profiles.find((p) => p.id === 'p2')?.name, 'PAK DARMAWAN, S.Pd', 'In-memory V5 JSON backup must preserve session identity');
assert.equal(memory.get('user_precious_data'), 'DO_NOT_DELETE_THIS');
simulateQuotaExceeded = false;

// UI contract check: ZipExportModal forces skipDownload: false and App.tsx has beforeunload guard
const zipModalSource = readFileSync('src/components/ZipExportModal.tsx', 'utf8');
assert(zipModalSource.includes('skipDownload: false'), 'ZipExportModal must force skipDownload: false');
const appSource = readFileSync('src/App.tsx', 'utf8');
assert(appSource.includes("addEventListener('beforeunload'"), 'App.tsx must protect memory-only session state on refresh/close');

console.log('ALL_PRODUCTION_MODE_TESTS_PASSED');
