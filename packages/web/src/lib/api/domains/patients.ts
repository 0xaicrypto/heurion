import { ApiCore } from './core.js';
import type { MedicalRecordEntry, MedicalRecordEntryDraft, Patient, PatientDetail } from '../../types';

export class PatientsApi extends ApiCore {
  /* ────────────────────────── patients ────────────────────────── */

  async listPatients(): Promise<Patient[]> {
    return this.fetch<Patient[]>('/api/v1/dicom/patients/full');
  }

  async getPatientDetail(hash: string): Promise<PatientDetail> {
    return this.fetch<PatientDetail>(`/api/v1/dicom/patients/${hash}/detail`);
  }

  async deletePatient(hash: string): Promise<{ patient_hash: string; deleted: Record<string, number> }> {
    return this.fetch(`/api/v1/dicom/patients/${hash}`, { method: 'DELETE' });
  }

  async listMedicalRecords(patientHash: string): Promise<{records: Array<{id: string; patient_hash: string; title: string; sections: Record<string, string>; created_at: string; updated_at: string}>}> {
    return this.fetch(`/api/v1/medical-records?patient_hash=${encodeURIComponent(patientHash)}`);
  }

  async getMedicalRecord(id: string): Promise<{id: string; patient_hash: string; title: string; sections: Record<string, string>; created_at: string; updated_at: string}> {
    return this.fetch(`/api/v1/medical-records/${id}`);
  }

  async createMedicalRecord(data: {patient_hash: string; title: string; sections: Record<string, string>}): Promise<{id: string; patient_hash: string; title: string; sections: Record<string, string>; created_at: string; updated_at: string}> {
    return this.fetch('/api/v1/medical-records', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateMedicalRecord(id: string, data: {title?: string; sections?: Record<string, string>}): Promise<{id: string; patient_hash: string; title: string; sections: Record<string, string>; created_at: string; updated_at: string}> {
    return this.fetch(`/api/v1/medical-records/${id}`, { method: 'PUT', body: JSON.stringify(data) });
  }

  async deleteMedicalRecord(id: string): Promise<{deleted: boolean}> {
    return this.fetch(`/api/v1/medical-records/${id}`, { method: 'DELETE' });
  }

  /* ────────────────────────── medical record entries (Brain 2.0) ────────────────────────── */

  async listMedicalRecordEntries(
    patientHash: string,
    filters?: { type?: MedicalRecordEntry['type']; status?: MedicalRecordEntry['status'] },
  ): Promise<{ records: MedicalRecordEntry[] }> {
    const params = new URLSearchParams();
    if (filters?.type) params.set('type', filters.type);
    if (filters?.status) params.set('status', filters.status);
    const qs = params.toString();
    return this.fetch(`/api/v1/patients/${encodeURIComponent(patientHash)}/medical-records${qs ? `?${qs}` : ''}`);
  }

  async createMedicalRecordEntry(patientHash: string, data: MedicalRecordEntryDraft): Promise<MedicalRecordEntry> {
    return this.fetch(`/api/v1/patients/${encodeURIComponent(patientHash)}/medical-records`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateMedicalRecordEntry(
    patientHash: string,
    id: string,
    data: Partial<MedicalRecordEntryDraft> & { rejectedReason?: string },
  ): Promise<MedicalRecordEntry> {
    return this.fetch(`/api/v1/patients/${encodeURIComponent(patientHash)}/medical-records/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async deleteMedicalRecordEntry(patientHash: string, id: string): Promise<{deleted: boolean}> {
    return this.fetch(`/api/v1/patients/${encodeURIComponent(patientHash)}/medical-records/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  /* ────────────────────────── patient registration ────────────────────────── */

  async registerPatient(data: {
    name?: string;
    initials?: string;
    mrn?: string;
    age?: number;
    sex?: string;
    chief_complaint?: string;
    notes?: string;
  }): Promise<{ patient_hash: string; name?: string; initials?: string }> {
    return this.fetch('/api/v1/dicom/patients/register-manual', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

}
