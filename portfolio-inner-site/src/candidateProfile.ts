import { ApiError, request } from './api';

export interface CandidateProfileData {
    id: string;
    name: string | null;
    email: string | null;
    specializations: { name: string; declared: string | null; source: string | null;
        confirmed: string | null; refuted: boolean; tests: number; passed: number }[];
    fsp: {
        linked: boolean;
        linked_at: string | null;
        competencies: { id: string; kind: string; name: string; degree: number;
            degree_name: string; points: number; competitions: string[] }[];
        competitions: { id: string; name: string; start_date: string; end_date: string;
            level: string; role: string; result: string; points: number; task: string; competencies: string[] }[];
    };
    tests: { id: string; specialization: string; grade: string; passed: boolean;
        created_at: string | null; language: string | null; credited: boolean;
        procedural_check: boolean; llm_check: boolean; resource: string | null; symptoms: string[] }[];
    assignments: { id: string; title: string; project: string; status: string; status_name: string;
        created_at: string | null; updated_at: string; tasks: string[]; answers: string[] }[];
}

export function fetchCandidateProfile(userId: string, applicantId: string): Promise<CandidateProfileData> {
    return request('Профиль кандидата', `/api/applicants/profile?user_id=${encodeURIComponent(userId)}&applicant_id=${encodeURIComponent(applicantId)}`);
}

export function fetchSelfProfile(userId: string): Promise<CandidateProfileData> {
    return request('Мой профиль', `/api/applicant/profile?user_id=${encodeURIComponent(userId)}`);
}

export async function downloadSelfProfile(userId: string): Promise<void> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(`/api/applicant/profile/pdf?user_id=${encodeURIComponent(userId)}`, { signal: controller.signal });
        if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw new ApiError(data.error || 'Не удалось сформировать PDF', response.status);
        }
        if (!response.headers.get('Content-Type')?.includes('application/pdf')) throw new ApiError('Сервер вернул неверный формат PDF', 0);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url; link.download = 'itinder-profile.pdf';
        document.body.appendChild(link); link.click(); link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
        if (failure instanceof ApiError) throw failure;
        throw new ApiError('Не удалось скачать PDF. Повторите попытку.', 0);
    } finally { window.clearTimeout(timer); }
}

// Видимость собственного профиля для рекрутёров (app/tools/profile_visibility.py):
// hidden — в app/db/user_blocks есть файл пользователя, и окно «Соискатели» его не показывает.
export interface ProfileVisibility {
    hidden: boolean;
    hidden_at: string | null;
}

export function fetchProfileVisibility(userId: string): Promise<ProfileVisibility> {
    return request('Видимость профиля', `/api/applicant/visibility?user_id=${encodeURIComponent(userId)}`);
}

export function saveProfileVisibility(userId: string, hidden: boolean): Promise<ProfileVisibility> {
    return request('Видимость профиля', '/api/applicant/visibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, hidden }),
    });
}
