// «Задачи на грейд» — тест «проблемы» (значок id 2 на рабочем столе): API для
// бэкендеров и аналитиков, интерфейсы для фронтендеров, система и документы
// для тестировщиков. Задание собирает и проверяет сервер
// (app/tools/grade_tests.py): окно получает только то, что видит кандидат,
// ответы остаются на сервере.
import { request } from './api';

export type Grade = 'Junior' | 'Middle' | 'Senior';

export interface Solution {
    id: string;
    name: string;
    description: string;
}

// Где случились проблемы: API-ресурс (api), компонент и экран интерфейса
// в контексте продукта (ui) или система, которую тестируют (qa).
export interface GradeResource {
    kind: 'api' | 'ui' | 'qa';
    label: string; // «API-ресурс», «Компонент», «Экран», «Система»
    name: string;
    description: string;
    endpoint?: string; // api
    context?: string; // ui: продукт
    context_description?: string;
    constraints?: string[]; // ui и qa: особенности продукта или системы
}

// Документ, с которым работает тестировщик: требование, лог CI, код автотеста…
export interface GradeArtifact {
    id: number;
    kind: string;
    name: string; // вид документа: «Лог CI», «Баг-репорт»
    title: string;
    format: 'text' | 'code'; // code — моноширинный, без переноса строк
    text: string;
}

export interface GradeTask {
    task_id: string;
    specialization: string; // Backend, Frontend, QA или Syst. Analyst
    grade: Grade;
    resource: GradeResource;
    symptoms: string[]; // по одному на проблему, все равноправные
    answer: {
        select: boolean; // выбрать решения из списка
        max_select: number | null; // не больше стольких (у Junior)
        text: boolean; // описать решения текстом (Senior)
        code: boolean; // написать код (Backend)
        side_effects: boolean; // проверяются побочные эффекты решений (Frontend, Middle и Senior)
        crutches: boolean; // костыли не засчитываются (QA)
    };
    limits: { text: number; code: number }; // символов
    solutions?: Solution[]; // если select
    languages?: string[]; // если code
    artifacts?: GradeArtifact[]; // QA: документы задания
    attachments?: number[][]; // QA: id документов к каждому симптому
}

export interface GradeAnswer {
    solutions?: string[];
    text?: string;
    language?: string;
    code?: string;
}

export type SolutionStatus = 'fixed' | 'mitigated' | 'missed' | 'crutch'; // crutch — только костыль (QA)
export type CodeStatus = 'ok' | 'weak' | 'missing';

export interface GradeResult {
    id: string; // итог теста: app/db/user_tests/<id>.json
    passed: boolean;
    specialization: string;
    grade: Grade;
    next_grade: Grade; // какой тест предложить дальше
    problems: { n: number; status: SolutionStatus | null; code: CodeStatus | null; comment: string }[];
    extra: number | null; // лишних решений в выборе
    max_extra: number | null; // сколько лишних допускается (Middle)
    summary: string; // итог от нейросети, если она проверяла
    code_skipped: boolean; // код не проверялся: выбор решений уже не прошёл
    checks: { procedural: boolean; llm: { llm: string; model: string } | null };
    failures: { llm: string; model: string; error: string }[];
    can_credit: boolean; // тестовая версия: непройденный тест можно засчитать (creditTest)
}

// Засчитанный тест: новая запись итога, будто тест сдан (только тестовая версия).
export interface GradeCredit {
    id: string; // запись app/db/user_tests/<id>.json
    passed: true;
    specialization: string;
    grade: Grade;
    next_grade: Grade;
    credited_from: string; // id непройденного итога
}

// Что сервер знает о пользователе (app/tools/grade_tests.py, profile): что он
// заявил, какие тесты прошёл, какой грейд из этого следует и какой тест предложить.
export interface GradeProfile {
    specializations: string[]; // на что есть задачи
    grades: Grade[];
    rules: {
        problem_count: { [grade in Grade]: number };
        junior_max_select: number;
        middle_max_extra: number;
        code: string[]; // специализации, которые пишут код
        side_effects: string[]; // специализации, у которых проверяются побочные эффекты решений
        crutches: string[]; // специализации, у которых костыли не засчитываются
    };
    // Последняя запись специализации: распознана по резюме (LLM) или выбрана вручную (Manual).
    declared: { specialization: string; grade: string; source: 'LLM' | 'Manual' | null; created_at: string } | null;
    // По этой специализации, новые первыми; credited — засчитан кнопкой тестовой версии.
    tests: { grade: Grade; passed: boolean; credited: boolean; created_at: string }[];
    computed: { specialization: string; grade: string; confirmed: boolean } | null; // confirmed — грейд подтверждён тестом
    // basis: passed / failed — следующий после последнего теста, declared — заявленный грейд,
    // default — нет записи или для её специализации нет задач.
    recommended: { specialization: string; grade: Grade; basis: 'passed' | 'failed' | 'declared' | 'default' };
}

// Нейросеть думает до двух минут, и запасная может начать через 20 с после первой.
const CHECK_TIMEOUT = 5 * 60 * 1000;

export function fetchProfile(userId: string): Promise<GradeProfile> {
    return request('Профиль для теста', `/api/grade_profile?user_id=${encodeURIComponent(userId)}`);
}

// Новое задание на выбранные специализацию и грейд.
export function createTask(userId: string, specialization: string, grade: Grade): Promise<GradeTask> {
    return request('Задание на грейд', '/api/grade_tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, specialization, grade }),
    });
}

export async function submitAnswer(userId: string, taskId: string, answer: GradeAnswer): Promise<GradeResult> {
    const result: GradeResult = await request(
        'Проверка теста',
        '/api/user_tests',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: userId, task_id: taskId, ...answer }),
        },
        CHECK_TIMEOUT
    );
    if (result.checks.llm) console.info(`Проверка теста: проверила ${result.checks.llm.llm} (${result.checks.llm.model})`);
    result.failures.forEach((failure) => console.warn(`Проверка теста: до неё не справилась ${failure.llm} (${failure.model}): ${failure.error}`));
    return result;
}

// Тестовая версия: засчитать непройденный тест (testId — id из GradeResult).
export function creditTest(userId: string, testId: string): Promise<GradeCredit> {
    return request('Засчитать тест', '/api/user_tests/credit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId, test_id: testId }),
    });
}
