// Анкета IT-проекта: схема — app/db/project_questionnaire.json, справочники —
// fsp_stack.json и fsp_team_roles.json, рынок — соискатели ITinder без имён
// (app/tools/projects.py, market). Схема описывает правила словами (syntax,
// rules, derived, market); здесь они же кодом: какие вопросы и блоки показать,
// что следует из ответов (эффекты), какие варианты стека сравнить по рынку
// и какие вакансии получаются.
//
// Вычисляемые значения зависят друг от друга по кругу: показ вопросов о продукте —
// от того, задан ли стек; позиции — от варианта мобильного приложения, который
// выбирают по рынку среди потребностей, а потребности — от позиций. Поэтому
// evaluate повторяет расчёт, пока результат не перестанет меняться (обычно 2–3 раза).
import type { OpenQuestion, Requirement, Vacancy } from './projects';

export type Kind = 'languages' | 'databases' | 'integrations' | 'testing';
export const KINDS: Kind[] = ['languages', 'databases', 'integrations', 'testing'];
export const GRADES = ['Junior', 'Middle', 'Senior'];
export const UNKNOWN = 'unknown';
export const NONE = 'none';

export interface StackItem {
    id: string;
    name: string;
    description?: string;
    roles?: string[];
    model?: string;
    mode?: string;
    area?: string;
    languages?: string[];
    [field: string]: any;
}
export type StackCatalog = { [kind in Kind]: StackItem[] };

export interface TeamRole {
    id: string;
    name: string;
    specialization: string;
    responsibilities: string;
}

export interface Applicant {
    role: string;
    grade: string;
    competencies: { [kindAndId: string]: number } | null;
}

export type Condition = { [key: string]: any };
export interface Effect {
    when?: Condition;
    [key: string]: any;
}
export interface Option {
    id: string;
    text: string;
    hint?: string;
    show_if?: Condition;
    exclusive?: boolean;
    effects?: Effect[];
    degree?: number;
}
export interface Question {
    id: string;
    type: string;
    text: string;
    hint?: string;
    required?: boolean;
    show_if?: Condition;
    default?: any;
    options?: Option[];
    effects?: Effect[] | { yes?: Effect[]; no?: Effect[] };
    kinds?: Kind[];
    per_kind?: boolean;
    multiple?: boolean;
    allow_unknown?: boolean;
    whole_kind?: boolean;
    pick_effect?: string | { when: Condition; effect: string }[];
    pick_reason?: string;
    roles?: string[];
    fields?: Question[];
    min_items?: number;
    max_items?: number;
    item_name?: string;
    rows?: string;
    max_length?: number;
    validate?: { rule: Condition; message: string }[];
    extra_options?: Option[];
    options_from?: string; // варианты — из поля элемента шаблона ($item.scope)
}
export interface Recommendation {
    id: string;
    when: Condition;
    for_each?: 'role';
    suggest?: { role: string; grade?: string; min: number };
    suggest_positions?: { position: string; min: number }[];
    text: string;
}
export interface Section {
    id: string;
    title: string;
    description?: string;
    show_if?: Condition;
    repeat?: string;
    item_key?: string;
    questions: Question[];
    notices?: { when: Condition; text: string }[];
    recommendations?: Recommendation[];
}
export interface PositionRule {
    id: string;
    role: string;
    name: string;
    reason?: string;
    when: Condition;
}
export interface MobileVariant {
    id: string;
    name: string;
    platforms: { [platform: string]: string[] };
    positions: { [platform: string]: string };
    note: string;
}
export interface MarketLevel {
    id: string;
    name: string;
    below?: number;
}
export interface QuestionnaireSchema {
    version: number;
    id: string;
    title: string;
    description: string;
    prelude?: string;
    references: { degrees: { values: { degree: number; name: string; means: string }[] } };
    rules: {
        kind_order: Kind[];
        kind_names: { [kind in Kind]: string };
        role_scope: {
            kinds: { [role: string]: Kind[] };
            only: { [role: string]: { [kind: string]: string[] } };
        };
        positions: PositionRule[];
        main_language_except: string[];
        default_min_degree: { required: { [grade: string]: number }; plus: number };
        adjacent: { kind: Kind; ids: string[]; note: string }[];
        mobile_variants: MobileVariant[];
        position_tasks: { [position: string]: string };
    };
    sections: Section[];
    market: { levels: MarketLevel[] };
}

export interface Catalog {
    schema: QuestionnaireSchema;
    stack: StackCatalog;
    roles: TeamRole[];
    market: Applicant[];
}

export type Answers = { [key: string]: any };
export type Matrix = { [row: string]: { [grade: string]: number } };

export interface PositionInfo {
    id: string;
    role: string;
    name: string;
    reasons: string[];
}

// Заданная компетенция (fix) или компетенция старой системы (legacy).
export interface FixedItem {
    key: string; // kind:id — ключ блока fixed_details
    kind: Kind;
    id: string;
    name: string;
    positions: string[]; // кому нужна: из эффекта, ответа fixed_details или потребностей, которые она закрыла
    scope: string[]; // каким позициям проекта доступна по rules.role_scope
    reasons: string[];
    origins: string[];
}

export interface Candidate {
    key: string; // id компетенции или варианта мобильного приложения
    ids: string[];
    name: string;
    note: string | null;
    supplyByGrade: { [grade: string]: number };
    supply: number;
    level: MarketLevel;
    weight: number;
    score: number;
    preferReasons: string[];
}

// Потребность: компетенция вида kind, конкретную выбирают по рынку.
export interface Need {
    key: string; // ключ блока market_choices
    kind: Kind;
    positions: string[];
    roles: string[];
    reasons: string[];
    variants: boolean;
    candidates: Candidate[]; // по убыванию score
    recommended: string;
    chosen: string[]; // ключи выбранных кандидатов; «не знаю» — пусто
    unknown: boolean;
    unconfirmed: number; // соискатели этих ролей без связки с ФСП
}

export interface ScarceItem {
    key: string; // kind:id:позиция:грейд — ключ блока scarcity
    kind: Kind;
    id: string;
    name: string;
    position: string;
    position_name: string;
    role: string;
    grade: string;
    min_degree: number;
    degree_name: string;
    lower_degree_name: string;
    supply: number;
    supply_lower: number;
    unconfirmed: number;
    adjacent: string[];
    adjacent_names: string;
    supply_adjacent: number;
    supply_any: number;
}

export interface Advice {
    text: string;
    tone: 'info' | 'warn';
}

export interface TemplateItem {
    key: string;
    vars: { [name: string]: any };
}

export interface SectionView {
    section: Section;
    items: TemplateItem[] | null; // у шаблона — его элементы
}

export interface Evaluation {
    visible: { [questionId: string]: boolean };
    sections: SectionView[]; // разделы мастера по порядку, без вакансий
    rolesNeeded: { [role: string]: string[] };
    positions: PositionInfo[];
    mobileVariant: MobileVariant | null;
    kindMode: { [kind in Kind]: string };
    openKinds: Kind[];
    stackMode: 'fixed' | 'free' | 'mixed';
    fixed: FixedItem[];
    legacy: FixedItem[];
    needs: Need[]; // все, и с одним кандидатом
    choices: Need[]; // с выбором
    projectLanguages: string[];
    staff: Matrix;
    scarce: ScarceItem[];
    gradeFloors: { role: string; grade: string; reason: string }[];
    advice: Advice[];
    openQuestions: OpenQuestion[];
    vacancies: Vacancy[];
}

interface Scope {
    item?: TemplateItem;
    section?: Section;
    listItem?: { [field: string]: any };
    role?: string;
}

interface Collected {
    effect: Effect;
    origin: string;
    vars?: { [name: string]: any };
}

const MAX_PASSES = 8;
const CLIENT_PLATFORMS = ['android', 'ios'];

// Подстановка {поле} в текст схемы.
export function format(text: string, vars?: { [name: string]: any }): string {
    if (!vars) return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined || vars[name] === null ? whole : String(vars[name])));
}

function unique<T>(items: T[]): T[] {
    return items.filter((item, index) => items.indexOf(item) === index);
}

function sum(values: number[]): number {
    return values.reduce((total, value) => total + value, 0);
}

export function isAnswered(question: Question, value: any): boolean {
    if (value === undefined || value === null) return false;
    switch (question.type) {
        case 'text':
        case 'textarea':
        case 'date':
            return typeof value === 'string' && value.trim() !== '';
        case 'multi':
        case 'market_choice':
            return Array.isArray(value) && value.length > 0;
        case 'stack_pick':
            if (question.per_kind) {
                return (question.kinds ?? []).every((kind) => {
                    const part = value?.[kind];
                    return part === NONE || part === UNKNOWN || (Array.isArray(part) && part.length > 0);
                });
            }
            return Array.isArray(value) && value.length > 0;
        case 'list':
            return Array.isArray(value) && value.length > 0;
        case 'team_matrix':
            return typeof value === 'object' && Object.keys(value).length > 0;
        default:
            return value !== '';
    }
}

export function templateKey(section: Section, item: TemplateItem, question: Question): string {
    return `${section.id}[${item.key}].${question.id}`;
}

function matrixRows(matrix: Matrix | undefined, row: string, rowsOf: (row: string) => string[]): number[] {
    if (!matrix) return [0];
    return rowsOf(row).map((name) => sum(GRADES.map((grade) => matrix[name]?.[grade] ?? 0)));
}

// Ссылка на ячейки матрицы: total, <строка>, <строка>.<грейд>, <строка>.<грейд>+, *.<грейд>.
function matrixRef(matrix: Matrix | undefined, path: string[], rowsOf: (row: string) => string[], allRows: string[]): any {
    if (!matrix) matrix = {};
    const [row, gradeSpec] = path;
    if (row === undefined) return undefined;
    if (row === 'total') return sum(allRows.map((name) => sum(GRADES.map((grade) => matrix![name]?.[grade] ?? 0))));
    const rows = row === '*' ? allRows : rowsOf(row);
    if (gradeSpec === undefined) return sum(matrixRows(matrix, row, row === '*' ? () => allRows : rowsOf));
    const andUp = gradeSpec.endsWith('+');
    const grade = andUp ? gradeSpec.slice(0, -1) : gradeSpec;
    const grades = andUp ? GRADES.slice(GRADES.indexOf(grade)) : [grade];
    return sum(rows.map((name) => sum(grades.map((g) => matrix![name]?.[g] ?? 0))));
}

export class QuestionnaireEngine {
    readonly schema: QuestionnaireSchema;
    readonly stack: StackCatalog;
    readonly roles: { [id: string]: TeamRole };
    readonly market: Applicant[];
    readonly items: { [kind: string]: { [id: string]: StackItem } };
    readonly statics: { [id: string]: Question } = {};
    readonly positionRules: { [id: string]: PositionRule } = {};
    readonly variants: { [id: string]: MobileVariant } = {};

    // Расчёт текущего прохода: answers — ответы, prev — прошлый проход.
    private answers: Answers = {};
    private prev: Evaluation;
    private visibleNow: { [id: string]: boolean } = {};
    private overrides: { [ref: string]: any } = {};

    constructor(catalog: Catalog) {
        this.schema = catalog.schema;
        this.stack = catalog.stack;
        this.market = catalog.market;
        this.roles = {};
        catalog.roles.forEach((role) => (this.roles[role.id] = role));
        this.items = {};
        KINDS.forEach((kind) => {
            this.items[kind] = {};
            (catalog.stack[kind] ?? []).forEach((item) => (this.items[kind][item.id] = item));
        });
        this.schema.sections
            .filter((section) => !section.repeat)
            .forEach((section) => section.questions.forEach((question) => (this.statics[question.id] = question)));
        this.schema.rules.positions.forEach((rule) => (this.positionRules[rule.id] = rule));
        this.schema.rules.mobile_variants.forEach((variant) => (this.variants[variant.id] = variant));
        this.prev = this.empty();
    }

    // --- Справочники -------------------------------------------------------------

    kindName(kind: Kind): string {
        return this.schema.rules.kind_names[kind] ?? kind;
    }

    itemName(kind: Kind, id: string): string {
        return this.items[kind]?.[id]?.name ?? id;
    }

    degreeName(degree: number): string {
        return this.schema.references.degrees.values.find((value) => value.degree === degree)?.name ?? String(degree);
    }

    defaultDegree(grade: string): number {
        return this.schema.rules.default_min_degree.required[grade] ?? 1;
    }

    // Может ли компетенция стоять в требованиях роли (rules.role_scope).
    inScope(role: string, kind: Kind, id: string): boolean {
        const scope = this.schema.rules.role_scope;
        if (!(scope.kinds[role] ?? []).includes(kind)) return false;
        const item = this.items[kind]?.[id];
        if (!item) return false;
        if (kind === 'languages' && !(item.roles ?? []).includes(role)) return false;
        const only = scope.only[role]?.[kind];
        return !only || only.includes(id);
    }

    roleOf(position: string): string {
        return this.positionRules[position]?.role ?? position;
    }

    adjacentOf(kind: Kind, id: string): string[] {
        return unique(
            this.schema.rules.adjacent
                .filter((group) => group.kind === kind && group.ids.includes(id))
                .flatMap((group) => group.ids)
                .filter((other) => other !== id)
        );
    }

    level(supply: number): MarketLevel {
        const levels = this.schema.market.levels;
        return levels.find((level) => level.below !== undefined && supply < level.below) ?? levels[levels.length - 1];
    }

    // Чем займётся человек на позиции — по умолчанию в вакансии (rules.position_tasks).
    positionTask(position: string): string {
        return this.schema.rules.position_tasks?.[position] ?? this.roles[this.roleOf(position)]?.responsibilities ?? '';
    }

    // --- Рынок --------------------------------------------------------------------

    // Соискатели роли с грейдом из grades и компетенцией kind из ids (любой) со
    // степенью не ниже minDegree(грейд соискателя). ids пуст — без требования к стеку.
    count(role: string, grades: string[], kind: Kind | null, ids: string[], minDegree: (grade: string) => number): number {
        return this.market.filter((applicant) => {
            if (applicant.role !== role || !grades.includes(applicant.grade)) return false;
            if (!kind || !ids.length) return true;
            const competencies = applicant.competencies;
            return !!competencies && ids.some((id) => (competencies[`${kind}:${id}`] ?? 0) >= minDegree(applicant.grade));
        }).length;
    }

    unlinked(role: string, grades: string[] = GRADES): number {
        return this.market.filter((a) => a.role === role && grades.includes(a.grade) && !a.competencies).length;
    }

    gradesFrom(grade: string): string[] {
        return GRADES.slice(Math.max(0, GRADES.indexOf(grade)));
    }

    // Сколько соискателей подходит под вакансию: роль, грейд не ниже, все обязательные
    // требования со степенью не ниже нужной. unconfirmed — без связки с ФСП.
    vacancyMatches(vacancy: Vacancy): { confirmed: number; unconfirmed: number } {
        const grades = this.gradesFrom(vacancy.grade);
        const required = vacancy.requirements.filter((row) => row.importance === 'required');
        let confirmed = 0;
        let unconfirmed = 0;
        this.market.forEach((applicant) => {
            if (applicant.role !== vacancy.role_id || !grades.includes(applicant.grade)) return;
            const competencies = applicant.competencies;
            if (!competencies) {
                unconfirmed += 1;
                return;
            }
            const fits = required.every((row) => {
                const has = (id: string) => (competencies[`${row.kind}:${id}`] ?? 0) >= row.min_degree;
                return row.match === 'any' ? row.ids.some(has) : row.ids.every(has);
            });
            if (fits) confirmed += 1;
        });
        return { confirmed, unconfirmed };
    }

    // --- Условия --------------------------------------------------------------------

    private answerOf(id: string): any {
        const visible = id in this.visibleNow ? this.visibleNow[id] : this.prev.visible[id];
        return visible ? this.answers[id] : undefined;
    }

    templateValue(section: Section, item: TemplateItem, question: Question, answers: Answers = this.answers): any {
        const value = answers[templateKey(section, item, question)];
        if (value !== undefined && value !== null) return value;
        const fallback = question.default;
        if (typeof fallback === 'string' && fallback.startsWith('$item.')) return item.vars[fallback.slice(6)];
        return fallback;
    }

    private rowsOfPlan = (row: string): string[] => {
        if (this.roles[row]) return this.schema.rules.positions.filter((p) => p.role === row).map((p) => p.id);
        return [row];
    };

    private resolve(ref: string, scope: Scope): any {
        if (scope.role) ref = ref.replace('$role', scope.role);
        if (ref.startsWith('$item.')) return scope.item?.vars[ref.slice(6)];
        if (ref in this.overrides) return this.overrides[ref];
        const parts = ref.split('.');
        const head = parts[0];
        if (scope.listItem && head in scope.listItem) return scope.listItem[head];
        if (scope.item && scope.section) {
            const question = scope.section.questions.find((q) => q.id === head);
            if (question) return this.templateValue(scope.section, scope.item, question);
        }
        const d = this.prev;
        switch (head) {
            case 'kind_mode':
                return d.kindMode[parts[1] as Kind];
            case 'open_kinds':
                return d.openKinds;
            case 'stack_mode':
                return d.stackMode;
            case 'roles_needed':
                return Object.keys(d.rolesNeeded);
            case 'mobile_variant':
                return d.mobileVariant?.id ?? null;
            case 'staff':
                return matrixRef(d.staff, parts.slice(1), (row) => [row], Object.keys(this.roles));
        }
        const question = this.statics[head];
        if (!question) return undefined;
        const value = this.answerOf(head);
        if (parts.length === 1) return value;
        if (question.type === 'list') return parts[1] === 'count' ? (Array.isArray(value) ? value.length : 0) : undefined;
        if (question.type === 'team_matrix') {
            if (question.rows === 'positions') {
                return matrixRef(value, parts.slice(1), this.rowsOfPlan, this.schema.rules.positions.map((p) => p.id));
            }
            return matrixRef(value, parts.slice(1), (row) => [row], Object.keys(this.roles));
        }
        return undefined;
    }

    test(condition: Condition | undefined, scope: Scope = {}): boolean {
        if (!condition) return true;
        if (condition.all) return condition.all.every((c: Condition) => this.test(c, scope));
        if (condition.any) return condition.any.some((c: Condition) => this.test(c, scope));
        if (condition.not) return !this.test(condition.not, scope);
        if (condition.ratio) {
            const { of, per, gt } = condition.ratio;
            const total = sum(of.map((ref: string) => Number(this.resolve(ref, scope) ?? 0)));
            return total > gt * Number(this.resolve(per, scope) ?? 0);
        }
        const value = this.resolve(condition.ref, scope);
        if ('is' in condition) return Array.isArray(value) ? value.includes(condition.is) : value === condition.is;
        if ('in' in condition) return condition.in.includes(value);
        if ('has' in condition) return Array.isArray(value) && value.includes(condition.has);
        if ('has_any' in condition) return Array.isArray(value) && condition.has_any.some((v: any) => value.includes(v));
        if ('gte' in condition) return Number(value ?? 0) >= condition.gte;
        if ('lt' in condition) return Number(value ?? 0) < condition.lt;
        if ('answered' in condition) {
            const answered = Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
            return answered === condition.answered;
        }
        return true;
    }

    // Условие в контексте шаблона или элемента списка — для окна.
    testIn(condition: Condition | undefined, answers: Answers, scope: Scope): boolean {
        const saved = this.answers;
        this.answers = answers;
        try {
            return this.test(condition, scope);
        } finally {
            this.answers = saved;
        }
    }

    // --- Эффекты ----------------------------------------------------------------------

    private pickType(question: Question, scope: Scope): string | null {
        const pick = question.pick_effect;
        if (!pick) return null;
        if (typeof pick === 'string') return pick;
        return pick.find((entry) => this.test(entry.when, scope))?.effect ?? null;
    }

    private collectQuestion(
        question: Question,
        value: any,
        scope: Scope,
        out: Collected[],
        whole: { [kind: string]: string },
        questions: OpenQuestion[]
    ) {
        const push = (effects: Effect[] | undefined) =>
            (effects ?? []).forEach((effect) => {
                if (this.test(effect.when, scope)) out.push({ effect, origin: question.id, vars: scope.listItem ?? scope.item?.vars });
            });
        const effects = question.effects;
        if (Array.isArray(effects)) push(effects);
        else if (effects && question.type === 'yes_no') push(effects[value as 'yes' | 'no']);
        if (question.options) {
            const selected = Array.isArray(value) ? value : [value];
            question.options
                .filter((option) => selected.includes(option.id) && this.test(option.show_if, scope))
                .forEach((option) => push(option.effects));
        }
        if (question.extra_options) {
            const selected = Array.isArray(value) ? value : [value];
            question.extra_options.filter((option) => selected.includes(option.id)).forEach((option) => push(option.effects));
        }
        if (question.type === 'stack_pick') this.collectPick(question, value, scope, out, whole, questions);
        if (question.type === 'list' && Array.isArray(value)) {
            value.forEach((entry: { [field: string]: any }) =>
                (question.fields ?? []).forEach((field) => {
                    const fieldScope = { listItem: entry };
                    if (!this.test(field.show_if, fieldScope) || !isAnswered(field, entry[field.id])) return;
                    this.collectQuestion(field, entry[field.id], fieldScope, out, whole, questions);
                })
            );
        }
    }

    private collectPick(
        question: Question,
        value: any,
        scope: Scope,
        out: Collected[],
        whole: { [kind: string]: string },
        questions: OpenQuestion[]
    ) {
        const type = this.pickType(question, scope);
        const reason = format(question.pick_reason ?? question.text, scope.listItem);
        const kinds = question.kinds ?? [];
        const handle = (kind: Kind, part: any) => {
            const isWhole = !!question.whole_kind && type === 'fix';
            if (Array.isArray(part)) {
                const ids = part.filter((id: string) => this.items[kind]?.[id]);
                if (ids.length && type) {
                    out.push({
                        effect: { [type]: { kind, ids }, roles: question.roles, reason },
                        origin: question.id,
                        vars: scope.listItem,
                    });
                }
                if (isWhole) whole[kind] = 'fixed';
            } else if (part === NONE) {
                if (isWhole) whole[kind] = 'fixed';
            } else if (part === UNKNOWN && isWhole) {
                whole[kind] = 'unknown';
                questions.push({
                    text: `Уточните у техлида: ${this.kindName(kind).toLowerCase()} — ${question.text}`,
                    blocking: true,
                    origin: question.id,
                    resolved: false,
                });
            }
        };
        if (question.per_kind) {
            kinds.forEach((kind) => handle(kind, value?.[kind]));
        } else if (Array.isArray(value)) {
            kinds.forEach((kind) => {
                const ids = value.filter((id: string) => this.items[kind]?.[id]);
                if (ids.length) handle(kind, ids);
            });
        }
    }

    // --- Расчёт -------------------------------------------------------------------------

    private empty(): Evaluation {
        return {
            visible: {},
            sections: [],
            rolesNeeded: {},
            positions: [],
            mobileVariant: null,
            kindMode: { languages: 'free', databases: 'free', integrations: 'free', testing: 'free' },
            openKinds: [...KINDS],
            stackMode: 'free',
            fixed: [],
            legacy: [],
            needs: [],
            choices: [],
            projectLanguages: [],
            staff: {},
            scarce: [],
            gradeFloors: [],
            advice: [],
            openQuestions: [],
            vacancies: [],
        };
    }

    evaluate(answers: Answers): Evaluation {
        this.answers = answers;
        this.prev = this.empty();
        let signature = '';
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            const next = this.pass();
            const nextSignature = JSON.stringify([
                next.visible,
                next.positions.map((p) => p.id),
                next.mobileVariant?.id,
                next.kindMode,
                next.projectLanguages,
                Object.keys(next.rolesNeeded),
                next.needs.map((n) => [n.key, n.chosen, n.positions]),
                next.stackMode,
            ]);
            this.prev = next;
            if (nextSignature === signature) break;
            signature = nextSignature;
        }
        return this.prev;
    }

    private pass(): Evaluation {
        const d = this.empty();
        const questions: OpenQuestion[] = [];
        this.overrides = {};

        // Показ вопросов: по порядку; ссылки на более поздние — по прошлому проходу.
        this.visibleNow = {};
        const staticSections = this.schema.sections.filter((section) => !section.repeat);
        staticSections.forEach((section) => {
            const shown = this.test(section.show_if);
            section.questions.forEach((question) => {
                this.visibleNow[question.id] = shown && this.test(question.show_if);
            });
        });
        d.visible = { ...this.visibleNow };

        // Эффекты ответов.
        const collected: Collected[] = [];
        const whole: { [kind: string]: string } = {};
        staticSections.forEach((section) =>
            section.questions.forEach((question) => {
                const value = this.answerOf(question.id);
                if (!d.visible[question.id] || !isAnswered(question, value)) return;
                this.collectQuestion(question, value, {}, collected, whole, questions);
            })
        );
        const effectsOf = (type: string) => collected.filter((entry) => entry.effect[type] !== undefined);

        // Роли и позиции.
        const roleReasons: { [role: string]: string[] } = {};
        const addRole = (role: string, reason: string) => {
            roleReasons[role] = unique([...(roleReasons[role] ?? []), reason]);
        };
        effectsOf('role').forEach(({ effect, vars }) => addRole(effect.role, format(effect.reason ?? '', vars)));
        const currentTeam: Matrix | undefined = this.answerOf('current_team');
        Object.keys(this.roles).forEach((role) => {
            if (sum(GRADES.map((grade) => currentTeam?.[role]?.[grade] ?? 0)) > 0) addRole(role, 'Уже есть в команде');
        });

        d.mobileVariant = this.answerOf('mobile_native') === 'native' ? this.variants.native : null;
        if (!d.mobileVariant) {
            const variantNeed = this.prev.needs.find((need) => need.variants);
            const chosen = variantNeed?.chosen[0];
            d.mobileVariant = chosen ? this.variants[chosen] ?? null : null;
        }
        this.overrides.mobile_variant = d.mobileVariant?.id ?? null;
        const evaluatePositions = () =>
            this.schema.rules.positions.filter((rule) => this.test(rule.when)).map((rule) => rule.id);
        this.overrides.roles_needed = Object.keys(roleReasons);
        let positionIds = evaluatePositions();
        positionIds.forEach((id) => {
            const rule = this.positionRules[id];
            if (rule.reason) addRole(rule.role, rule.reason);
        });
        this.overrides.roles_needed = Object.keys(roleReasons);
        positionIds = evaluatePositions();
        d.rolesNeeded = roleReasons;
        d.positions = positionIds.map((id) => {
            const rule = this.positionRules[id];
            return {
                id,
                role: rule.role,
                name: format(rule.name, { mobile_variant_name: d.mobileVariant?.name }),
                reasons: rule.reason ? [rule.reason] : roleReasons[rule.role] ?? [],
            };
        });
        const project = (ids: string[]) => ids.filter((id) => positionIds.includes(id));
        const positionsFor = (roles?: string[]): string[] => {
            if (!roles) return positionIds.slice();
            return unique(
                roles.flatMap((role) => (this.roles[role] ? positionIds.filter((id) => this.roleOf(id) === role) : project([role])))
            );
        };
        const scopeOf = (kind: Kind, id: string) => positionIds.filter((p) => this.inScope(this.roleOf(p), kind, id));

        // Заданный стек, стек старой системы, разрешённое стандартом.
        const allowed: { [kind: string]: string[] } = {};
        effectsOf('allow').forEach(({ effect }) => {
            const { kind, ids } = effect.allow;
            allowed[kind] = allowed[kind] ? allowed[kind].filter((id) => ids.includes(id)) : ids.slice();
        });
        const itemsFrom = (type: 'fix' | 'legacy', extra: Collected[]): FixedItem[] => {
            const found: { [key: string]: FixedItem } = {};
            const order: string[] = [];
            const add = (kind: Kind, id: string, positions: string[], reason: string, origin: string) => {
                const key = `${kind}:${id}`;
                const scope = scopeOf(kind, id);
                if (!found[key]) {
                    found[key] = { key, kind, id, name: this.itemName(kind, id), positions: [], scope, reasons: [], origins: [] };
                    order.push(key);
                }
                const item = found[key];
                item.positions = unique([...item.positions, ...positions.filter((p) => scope.includes(p))]);
                if (reason) item.reasons = unique([...item.reasons, reason]);
                item.origins = unique([...item.origins, origin]);
            };
            [...effectsOf(type), ...extra].forEach(({ effect, origin, vars }) => {
                const body = effect[type];
                const reason = format(effect.reason ?? '', vars);
                if (body.variant) {
                    const variant = this.variants[body.variant];
                    const clients: string[] = this.answerOf('clients') ?? [];
                    CLIENT_PLATFORMS.filter((platform) => clients.includes(platform)).forEach((platform) =>
                        (variant?.platforms[platform] ?? []).forEach((id) =>
                            add(body.kind, id, project([variant.positions[platform]]), reason, origin)
                        )
                    );
                    return;
                }
                const ids: string[] = body.ids;
                const rolesOf = (id: string) => this.items.languages[id]?.roles ?? [];
                // Рядом выбран язык только для сервера (Java, Go…) — язык, на котором пишет и фронтенд
                // (TypeScript, Kotlin), по умолчанию достаётся фронтендерам (rules.language_split).
                const serverOnly =
                    body.kind === 'languages' && ids.some((id) => rolesOf(id).includes('backend') && !rolesOf(id).includes('frontend'));
                ids.forEach((id) => {
                    let positions = effect.roles ? positionsFor(effect.roles) : positionIds.slice();
                    if (!effect.roles && body.kind === 'languages') {
                        // Тестировщику язык даёт инструмент тестирования (rules.qa_language).
                        positions = positions.filter((p) => this.roleOf(p) !== 'qa');
                        const front = positions.filter((p) => this.roleOf(p) === 'frontend' && this.inScope('frontend', 'languages', id));
                        if (serverOnly && rolesOf(id).includes('frontend') && front.length) positions = front;
                    }
                    add(body.kind, id, positions, reason, origin);
                });
            });
            return order.map((key) => found[key]);
        };
        const singleAllowed: Collected[] = Object.keys(allowed)
            .filter((kind) => allowed[kind].length === 1)
            .map((kind) => ({
                effect: { fix: { kind, ids: allowed[kind] }, reason: 'Единственный вариант, разрешённый стандартом' },
                origin: 'standard',
            }));
        d.fixed = itemsFrom('fix', singleAllowed);
        d.legacy = itemsFrom('legacy', []);
        d.fixed
            .filter((item) => !item.scope.length)
            .forEach((item) =>
                questions.push({
                    text: `«${item.name}» есть в заданном стеке, но в проекте нет позиции, которой эта компетенция нужна`,
                    blocking: false,
                    origin: item.origins[0] ?? null,
                    resolved: false,
                })
            );
        d.fixed = d.fixed.filter((item) => item.scope.length);

        // Режим каждого вида стека.
        KINDS.forEach((kind) => {
            if (whole[kind]) d.kindMode[kind] = whole[kind];
            else if (d.fixed.some((item) => item.kind === kind)) d.kindMode[kind] = 'partial';
            else if (allowed[kind]) d.kindMode[kind] = 'restricted';
            else d.kindMode[kind] = 'free';
        });
        d.openKinds = KINDS.filter((kind) => ['free', 'partial', 'restricted'].includes(d.kindMode[kind]));
        const relevant = KINDS.filter((kind) => kind !== 'testing' || !!roleReasons.qa);
        d.stackMode = !relevant.some((kind) => d.openKinds.includes(kind)) ? 'fixed' : d.fixed.length ? 'mixed' : 'free';

        // Потребности.
        const manual = this.answerOf('qa_automation') === 'manual';
        const languagesBefore = this.prev.projectLanguages;
        const testingMatch = (id: string) => {
            const languages = this.items.testing[id]?.languages ?? [];
            if (!languages.length) return true;
            if (manual) return false;
            return !languagesBefore.length || languages.some((language) => languagesBefore.includes(language));
        };
        const clients: string[] = this.answerOf('clients') ?? [];
        const platforms = CLIENT_PLATFORMS.filter((platform) => clients.includes(platform));
        const fixedLanguages = d.fixed.filter((item) => item.kind === 'languages').map((item) => item.id);
        const blocking = (text: string, origin: string) => questions.push({ text, blocking: true, origin, resolved: false });

        const raw: Collected[] = [
            {
                effect: {
                    need: { kind: 'languages', where: { roles: 'backend' }, except: this.schema.rules.main_language_except },
                    roles: ['backend_main'],
                    reason: 'Основной язык серверной части',
                },
                origin: 'base_needs',
            },
            ...effectsOf('need'),
        ];
        const resolved: Need[] = [];
        raw.forEach(({ effect, origin, vars }) => {
            const body = effect.need;
            const kind: Kind = body.kind;
            const reason = format(effect.reason ?? '', vars);
            if (body.variants) {
                if (!platforms.length || d.kindMode.languages === 'unknown') return;
                let variants: MobileVariant[] = (body.variants as string[]).map((id) => this.variants[id]).filter(Boolean);
                const languagesOf = (variant: MobileVariant) => unique(platforms.flatMap((p) => variant.platforms[p] ?? []));
                if (allowed.languages) variants = variants.filter((v) => languagesOf(v).every((id) => allowed.languages.includes(id)));
                if (d.kindMode.languages === 'fixed') {
                    if (!variants.some((v) => languagesOf(v).every((id) => fixedLanguages.includes(id)))) {
                        blocking(`${reason}: в заданном стеке нет языков мобильной разработки — уточните у техлида`, origin);
                    }
                    return;
                }
                if (!variants.length) {
                    blocking(`${reason}: нет разрешённых вариантов мобильного приложения`, origin);
                    return;
                }
                resolved.push(this.makeNeed(kind, [], ['frontend'], [reason], variants.map((v) => v.id), true, platforms));
                return;
            }
            let positions = positionsFor(effect.roles);
            const roleNames = (p: string) => this.roleOf(p);
            let candidates: string[];
            if (body.ids) candidates = (body.ids as string[]).filter((id) => this.items[kind]?.[id]);
            else {
                const where = body.where ?? {};
                const except: string[] = body.except ?? [];
                candidates = (this.stack[kind] ?? [])
                    .filter((item) =>
                        Object.keys(where).every((field) => {
                            const wanted = Array.isArray(where[field]) ? where[field] : [where[field]];
                            const actual = item[field];
                            return Array.isArray(actual) ? actual.some((v) => wanted.includes(v)) : wanted.includes(actual);
                        })
                    )
                    .map((item) => item.id)
                    .filter((id) => !except.includes(id));
            }
            candidates = candidates.filter((id) => positions.some((p) => this.inScope(roleNames(p), kind, id)));
            positions = positions.filter((p) => candidates.some((id) => this.inScope(roleNames(p), kind, id)));
            if (!positions.length) return;
            if (kind === 'testing' && !roleReasons.qa) return;
            if (d.kindMode[kind] === 'unknown') return;
            const before = candidates.slice();
            const names = before.map((id) => this.itemName(kind, id)).join(', ');
            const hit = d.fixed.find(
                (item) => item.kind === kind && before.includes(item.id) && item.positions.some((p) => positions.includes(p))
            );
            if (hit) {
                hit.positions = unique([...hit.positions, ...positions.filter((p) => hit.scope.includes(p))]);
                hit.reasons = unique([...hit.reasons, reason]);
                return;
            }
            // Инструменты тестирования добавляются и к заданным (rules.need_satisfied): выбор, как при partial.
            if (d.kindMode[kind] === 'fixed' && kind !== 'testing') {
                blocking(`${reason}: в заданном стеке нет подходящей компетенции (${names}) — уточните у техлида`, origin);
                return;
            }
            if (allowed[kind]) candidates = candidates.filter((id) => allowed[kind].includes(id));
            if (kind === 'testing') candidates = candidates.filter(testingMatch);
            if (!candidates.length) {
                if (kind !== 'testing') blocking(`${reason}: нет разрешённых вариантов из ${names}`, origin);
                return;
            }
            resolved.push(this.makeNeed(kind, positions, unique(positions.map(roleNames)), [reason], candidates, false, platforms));
        });

        // Слияние: одинаковые кандидаты — одна потребность; более узкая поглощает широкую.
        const merged: Need[] = [];
        resolved.forEach((need) => {
            const same = merged.find((other) => other.key === need.key);
            if (same) {
                same.positions = unique([...same.positions, ...need.positions]);
                same.roles = unique([...same.roles, ...need.roles]);
                same.reasons = unique([...same.reasons, ...need.reasons]);
            } else merged.push(need);
        });
        const idsOf = (need: Need) => need.candidates.map((c) => c.key);
        let changed = true;
        while (changed) {
            changed = false;
            for (const narrow of merged) {
                const wide = merged.find(
                    (other) =>
                        other !== narrow &&
                        !other.variants &&
                        !narrow.variants &&
                        other.kind === narrow.kind &&
                        idsOf(narrow).length < idsOf(other).length &&
                        idsOf(narrow).every((id) => idsOf(other).includes(id)) &&
                        other.positions.some((p) => narrow.positions.includes(p))
                );
                if (wide) {
                    narrow.positions = unique([
                        ...narrow.positions,
                        ...wide.positions.filter((p) => idsOf(narrow).some((id) => this.inScope(this.roleOf(p), narrow.kind, id))),
                    ]);
                    narrow.roles = unique(narrow.positions.map((p) => this.roleOf(p)));
                    narrow.reasons = unique([...narrow.reasons, ...wide.reasons]);
                    merged.splice(merged.indexOf(wide), 1);
                    changed = true;
                    break;
                }
            }
        }

        // Рынок: веса предпочтений, score, рекомендуемый, выбор рекрутёра.
        const prefers = effectsOf('prefer');
        const choiceSection = this.schema.sections.find((section) => section.repeat === 'market_choices');
        const choiceQuestion = choiceSection?.questions[0];
        merged.forEach((need) => {
            need.candidates.forEach((candidate) => {
                prefers.forEach(({ effect, vars }) => {
                    const body = effect.prefer;
                    if (body.kind !== need.kind || !candidate.ids.some((id) => body.ids.includes(id))) return;
                    if (effect.roles && !positionsFor(effect.roles).some((p) => need.positions.includes(p))) return;
                    if (need.variants) return;
                    candidate.weight += effect.weight ?? 1;
                    candidate.preferReasons = unique([...candidate.preferReasons, format(effect.reason ?? '', vars)]);
                });
                candidate.score = candidate.supply * (1 + 0.5 * candidate.weight);
            });
            const order = need.candidates.slice();
            need.candidates.sort((a, b) => b.score - a.score || order.indexOf(a) - order.indexOf(b));
            const allZero = need.candidates.every((c) => c.supply === 0);
            const best = allZero
                ? order.slice().sort((a, b) => b.weight - a.weight || order.indexOf(a) - order.indexOf(b))[0]
                : need.candidates[0];
            need.recommended = best.key;
            need.chosen = [best.key];
            if (need.candidates.length > 1 && choiceSection && choiceQuestion) {
                const item = this.choiceItem(need);
                const value = this.answers[templateKey(choiceSection, item, choiceQuestion)];
                if (Array.isArray(value) && value.length) {
                    need.unknown = value.includes(UNKNOWN);
                    const keys = value.filter((key: string) => need.candidates.some((c) => c.key === key));
                    need.chosen = need.unknown ? [] : need.variants ? keys.slice(0, 1) : keys;
                    if (!need.unknown && !need.chosen.length) need.chosen = [best.key];
                }
            }
        });
        d.needs = merged;
        d.choices = merged.filter((need) => need.candidates.length > 1);

        // Языки проекта: у бэкендеров и фронтендеров.
        const developer = (p: string) => ['backend', 'frontend'].includes(this.roleOf(p));
        const chosenLanguages = merged
            .filter((need) => need.kind === 'languages')
            .flatMap((need) =>
                need.variants
                    ? need.chosen.flatMap((key) => platforms.flatMap((p) => this.variants[key]?.platforms[p] ?? []))
                    : need.positions.some(developer)
                    ? need.chosen
                    : []
            );
        d.projectLanguages = unique([
            ...d.fixed.filter((item) => item.kind === 'languages' && item.positions.some(developer)).map((item) => item.id),
            ...chosenLanguages,
        ]);

        // Кому нужна заданная компетенция — как ответил рекрутёр в fixed_details.
        const fixedSection = this.schema.sections.find((section) => section.repeat === 'fixed_stack');
        if (fixedSection) {
            const positionsQuestion = fixedSection.questions.find((q) => q.id === 'positions');
            d.fixed.forEach((item) => {
                if (!positionsQuestion) return;
                const value = this.answers[templateKey(fixedSection, this.fixedItem(item), positionsQuestion)];
                if (Array.isArray(value)) item.positions = value.filter((p: string) => item.scope.includes(p));
            });
        }

        // Команда: план, кто уже есть, советы.
        const plan: Matrix = this.answerOf('team_plan') ?? {};
        d.staff = {};
        Object.keys(this.roles).forEach((role) => {
            d.staff[role] = {};
            GRADES.forEach((grade) => {
                const planned = sum(positionIds.filter((p) => this.roleOf(p) === role).map((p) => plan[p]?.[grade] ?? 0));
                d.staff[role][grade] = planned + (currentTeam?.[role]?.[grade] ?? 0);
            });
        });
        this.prev = { ...this.prev, staff: d.staff };
        d.gradeFloors = effectsOf('grade_floor').map(({ effect, vars }) => ({
            role: effect.grade_floor.role,
            grade: effect.grade_floor.grade,
            reason: format(effect.reason ?? '', vars),
        }));
        d.advice = this.advise(effectsOf('suggest'), d, plan);

        // Дефицит под заданный стек.
        d.scarce = this.scarceItems(d, plan);

        // Открытые вопросы из шаблонов («не знаю» в выборе по рынку).
        this.templateEffects(d, collected, whole, questions);
        effectsOf('open_question').forEach(({ effect, origin, vars }) =>
            questions.push({
                text: format(effect.open_question.text, vars),
                blocking: !!effect.open_question.blocking,
                origin,
                resolved: false,
            })
        );
        d.openQuestions = questions.filter((q, i) => questions.findIndex((other) => other.text === q.text) === i);

        d.vacancies = this.vacancies(d, plan, platforms);
        d.sections = this.sectionViews(d);
        return d;
    }

    private makeNeed(
        kind: Kind,
        positions: string[],
        roles: string[],
        reasons: string[],
        candidateIds: string[],
        variants: boolean,
        platforms: string[]
    ): Need {
        const candidates: Candidate[] = candidateIds.map((key) => {
            const variant = variants ? this.variants[key] : null;
            const ids = variant ? unique(platforms.flatMap((p) => variant.platforms[p] ?? [])) : [key];
            const supplyByGrade: { [grade: string]: number } = {};
            GRADES.forEach((grade) => {
                const counts = variant
                    ? ids.map((id) => this.count('frontend', [grade], 'languages', [id], () => this.defaultDegree(grade)))
                    : roles.map((role) => this.count(role, [grade], kind, ids, () => this.defaultDegree(grade)));
                supplyByGrade[grade] = counts.length ? Math.min(...counts) : 0;
            });
            const supply = sum(GRADES.map((grade) => supplyByGrade[grade]));
            return {
                key,
                ids,
                name: variant ? variant.name.charAt(0).toUpperCase() + variant.name.slice(1) : this.itemName(kind, key),
                note: variant ? variant.note : this.items[kind]?.[key]?.description ?? null,
                supplyByGrade,
                supply,
                level: this.level(supply),
                weight: 0,
                score: supply,
                preferReasons: [],
            };
        });
        const key = variants ? `${kind}:variants:${candidateIds.join(',')}` : `${kind}:${candidateIds.join(',')}`;
        return {
            key,
            kind,
            positions,
            roles,
            reasons,
            variants,
            candidates,
            recommended: candidateIds[0],
            chosen: [candidateIds[0]],
            unknown: false,
            unconfirmed: roles.length ? Math.min(...roles.map((role) => this.unlinked(role))) : 0,
        };
    }

    fixedItem(item: FixedItem): TemplateItem {
        return {
            key: item.key,
            vars: {
                kind: item.kind,
                id: item.id,
                name: item.name,
                kind_name: this.kindName(item.kind),
                scope: item.scope,
                positions: item.positions,
                reasons: item.reasons.join('; '),
            },
        };
    }

    choiceItem(need: Need): TemplateItem {
        return {
            key: need.key,
            vars: {
                kind_name: this.kindName(need.kind),
                reasons: need.reasons.join('; '),
                candidate_names: need.candidates.map((c) => c.name).join(', '),
                candidates: need.candidates,
                recommended: [need.recommended],
                need,
            },
        };
    }

    scarceItem(item: ScarceItem): TemplateItem {
        return { key: item.key, vars: { ...item } };
    }

    private templateEffects(d: Evaluation, collected: Collected[], whole: { [kind: string]: string }, questions: OpenQuestion[]) {
        this.schema.sections
            .filter((section) => section.repeat)
            .forEach((section) => {
                this.templateItems(section, d).forEach((item) =>
                    section.questions.forEach((question) => {
                        const scope = { item, section };
                        if (!this.test(question.show_if, scope)) return;
                        const value = this.answers[templateKey(section, item, question)];
                        if (value === undefined) return;
                        const out: Collected[] = [];
                        this.collectQuestion(question, value, scope, out, whole, questions);
                        collected.push(...out);
                    })
                );
            });
    }

    templateItems(section: Section, d: Evaluation): TemplateItem[] {
        switch (section.repeat) {
            case 'fixed_stack':
                return d.fixed.map((item) => this.fixedItem(item));
            case 'market_choices':
                return d.choices.map((need) => this.choiceItem(need));
            case 'scarce_items':
                return d.scarce.map((item) => this.scarceItem(item));
            default:
                return [];
        }
    }

    private sectionViews(d: Evaluation): SectionView[] {
        const views: SectionView[] = [];
        this.schema.sections.forEach((section) => {
            if (section.repeat === 'vacancy_cells') return; // вакансии правит отдельный редактор
            if (section.repeat) {
                const items = this.templateItems(section, d);
                if (items.length) views.push({ section, items });
                return;
            }
            if (section.questions.some((question) => d.visible[question.id])) views.push({ section, items: null });
        });
        return views;
    }

    private advise(suggestions: Collected[], d: Evaluation, plan: Matrix): Advice[] {
        const advice: Advice[] = [];
        const staffOf = (role: string, grade?: string) =>
            grade ? d.staff[role]?.[grade] ?? 0 : sum(GRADES.map((g) => d.staff[role]?.[g] ?? 0));
        const roleName = (role: string) => this.roles[role]?.name ?? role;
        suggestions.forEach(({ effect, vars }) => {
            const { role, grade, min } = effect.suggest;
            if (staffOf(role, grade) >= min) return;
            advice.push({
                text: `${format(effect.reason ?? '', vars)}: ${roleName(role)}${grade ? ` ${grade}` : ''} — не меньше ${min}`,
                tone: 'warn',
            });
        });
        const recommendations = this.schema.sections.find((s) => s.recommendations)?.recommendations ?? [];
        const vars = { analyst_reasons: (d.rolesNeeded.analyst ?? []).join('; ').toLowerCase() };
        recommendations.forEach((rule) => {
            const roles = rule.for_each === 'role' ? Object.keys(this.roles) : [undefined];
            roles.forEach((role) => {
                const scope = role ? { role } : {};
                if (!this.test(rule.when, scope)) return;
                if (rule.suggest) {
                    const suggestedRole = rule.suggest.role === '$role' ? role! : rule.suggest.role;
                    if (staffOf(suggestedRole, rule.suggest.grade) >= rule.suggest.min) return;
                }
                if (rule.suggest_positions && rule.suggest_positions.every((s) => sum(GRADES.map((g) => plan[s.position]?.[g] ?? 0)) >= s.min)) {
                    return;
                }
                const text = format(rule.text, vars);
                advice.push({ text: role ? `${roleName(role)}: ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text, tone: 'info' });
            });
        });
        d.gradeFloors.forEach((floor) => {
            const below = GRADES.slice(0, GRADES.indexOf(floor.grade));
            const positions = d.positions.filter((p) => floor.role === '*' || p.role === floor.role);
            if (positions.some((p) => below.some((grade) => (plan[p.id]?.[grade] ?? 0) > 0))) {
                advice.push({ text: `${floor.reason}. Ниже ${floor.grade} не советуем`, tone: 'warn' });
            }
        });
        return advice;
    }

    // Степень обязательной заданной компетенции на грейде: из fixed_details или по грейду.
    private fixedDegree(item: FixedItem, grade: string): { importance: 'required' | 'plus'; degree: number } {
        const section = this.schema.sections.find((s) => s.repeat === 'fixed_stack');
        const template = this.fixedItem(item);
        const question = (id: string) => section?.questions.find((q) => q.id === id);
        const importanceQuestion = question('importance');
        const depthQuestion = question('depth');
        const importance =
            section && importanceQuestion ? this.templateValue(section, template, importanceQuestion) ?? 'required' : 'required';
        if (importance === 'plus') return { importance, degree: this.schema.rules.default_min_degree.plus };
        const depth = section && depthQuestion ? this.templateValue(section, template, depthQuestion) : 'by_grade';
        const option = depthQuestion?.options?.find((o) => o.id === depth);
        return { importance: 'required', degree: option?.degree ?? this.defaultDegree(grade) };
    }

    private scarceItems(d: Evaluation, plan: Matrix): ScarceItem[] {
        const scarce: ScarceItem[] = [];
        const threshold = this.schema.market.levels[0]?.below ?? 3;
        d.fixed.forEach((item) =>
            item.positions.forEach((positionId) => {
                const position = d.positions.find((p) => p.id === positionId);
                if (!position) return;
                GRADES.forEach((grade) => {
                    if (!(plan[positionId]?.[grade] > 0)) return;
                    const { importance, degree } = this.fixedDegree(item, grade);
                    if (importance !== 'required') return;
                    const grades = this.gradesFrom(grade);
                    const supply = this.count(position.role, grades, item.kind, [item.id], () => degree);
                    if (supply >= threshold) return;
                    const adjacent = this.adjacentOf(item.kind, item.id).filter((id) => this.inScope(position.role, item.kind, id));
                    scarce.push({
                        key: `${item.kind}:${item.id}:${positionId}:${grade}`,
                        kind: item.kind,
                        id: item.id,
                        name: item.name,
                        position: positionId,
                        position_name: position.name,
                        role: position.role,
                        grade,
                        min_degree: degree,
                        degree_name: this.degreeName(degree),
                        lower_degree_name: this.degreeName(Math.max(1, degree - 1)),
                        supply,
                        supply_lower: this.count(position.role, grades, item.kind, [item.id], () => Math.max(1, degree - 1)),
                        unconfirmed: this.unlinked(position.role, grades),
                        adjacent,
                        adjacent_names: adjacent.map((id) => this.itemName(item.kind, id)).join(', '),
                        supply_adjacent: this.count(position.role, grades, item.kind, [item.id, ...adjacent], () => degree),
                        supply_any: this.count(position.role, grades, null, [], () => 1),
                    });
                });
            })
        );
        return scarce;
    }

    // Требования к стеку позиции на грейде.
    private requirements(d: Evaluation, positionId: string, grade: string, platforms: string[]): Requirement[] {
        const role = this.roleOf(positionId);
        const rows: Requirement[] = [];
        const add = (row: Requirement) => {
            row.ids = row.ids.filter((id) => this.inScope(role, row.kind, id));
            if (!row.ids.length) return;
            row.match = row.ids.length > 1 ? row.match : 'all';
            const key = `${row.kind}:${row.ids.slice().sort().join(',')}`;
            const same = rows.find((other) => `${other.kind}:${other.ids.slice().sort().join(',')}` === key);
            if (!same) {
                rows.push(row);
                return;
            }
            if (row.importance === 'required') same.importance = 'required';
            same.min_degree = Math.max(same.min_degree, row.min_degree);
            same.reasons = unique([...same.reasons, ...row.reasons]);
        };
        const byGrade = this.defaultDegree(grade);
        const plus = this.schema.rules.default_min_degree.plus;
        const scarcitySection = this.schema.sections.find((s) => s.repeat === 'scarce_items');
        d.fixed
            .filter((item) => item.positions.includes(positionId))
            .forEach((item) => {
                let { importance, degree } = this.fixedDegree(item, grade);
                let ids = [item.id];
                const scarce = d.scarce.find((s) => s.key === `${item.kind}:${item.id}:${positionId}:${grade}`);
                if (scarce && scarcitySection) {
                    const action = this.templateValue(scarcitySection, this.scarceItem(scarce), scarcitySection.questions[0]);
                    if (action === 'lower_degree') degree = Math.max(1, degree - 1);
                    if (action === 'adjacent') ids = [item.id, ...scarce.adjacent];
                    if (action === 'plus') {
                        importance = 'plus';
                        degree = plus;
                    }
                }
                add({ kind: item.kind, ids, match: 'any', importance, min_degree: degree, origin: 'fixed', reasons: item.reasons.slice() });
            });
        d.needs.forEach((need) => {
            if (need.variants) {
                need.chosen.forEach((key) => {
                    const variant = this.variants[key];
                    platforms
                        .filter((p) => variant?.positions[p] === positionId)
                        .forEach((p) =>
                            add({
                                kind: 'languages',
                                ids: variant.platforms[p].slice(),
                                match: 'all',
                                importance: 'required',
                                min_degree: byGrade,
                                origin: 'market',
                                reasons: need.reasons.slice(),
                            })
                        );
                });
                return;
            }
            if (!need.positions.includes(positionId) || !need.chosen.length) return;
            add({
                kind: need.kind,
                ids: need.chosen.slice(),
                match: 'any',
                importance: 'required',
                min_degree: byGrade,
                origin: 'market',
                reasons: need.reasons.slice(),
            });
        });
        d.legacy
            .filter((item) => item.positions.includes(positionId))
            .forEach((item) =>
                add({ kind: item.kind, ids: [item.id], match: 'all', importance: 'plus', min_degree: plus, origin: 'legacy', reasons: item.reasons.slice() })
            );
        // rules.sql: реляционная или колоночная СУБД в стеке — SQL бэкендеру плюсом, аналитику обязательно.
        const hasSqlDatabase = rows.some(
            (row) => row.kind === 'databases' && row.ids.some((id) => ['relational', 'columnar'].includes(this.items.databases[id]?.model ?? ''))
        );
        if (hasSqlDatabase && (role === 'backend' || role === 'analyst') && !rows.some((row) => row.kind === 'languages' && row.ids.includes('sql'))) {
            add({
                kind: 'languages',
                ids: ['sql'],
                match: 'all',
                importance: role === 'analyst' ? 'required' : 'plus',
                min_degree: role === 'analyst' ? byGrade : plus,
                origin: 'rule',
                reasons: ['В стеке реляционная или аналитическая СУБД'],
            });
        }
        // rules.qa_language: язык тестировщика — из инструментов тестирования с кодом.
        if (role === 'qa') {
            const tools = rows.filter((row) => row.kind === 'testing').flatMap((row) => row.ids);
            const toolLanguages = unique(tools.flatMap((id) => this.items.testing[id]?.languages ?? []));
            if (toolLanguages.length) {
                const shared = toolLanguages.filter((id) => d.projectLanguages.includes(id));
                add({
                    kind: 'languages',
                    ids: shared.length ? shared : toolLanguages,
                    match: 'any',
                    importance: 'required',
                    min_degree: byGrade,
                    origin: 'rule',
                    reasons: ['Язык автотестов'],
                });
            }
        }
        const order = (row: Requirement) => KINDS.indexOf(row.kind) * 2 + (row.importance === 'required' ? 0 : 1);
        return rows.sort((a, b) => order(a) - order(b));
    }

    // Вакансии из плана команды: позиция × грейд.
    private vacancies(d: Evaluation, plan: Matrix, platforms: string[]): Vacancy[] {
        const vacancies: Vacancy[] = [];
        d.positions.forEach((position) =>
            GRADES.forEach((grade) => {
                const count = plan[position.id]?.[grade] ?? 0;
                if (!(count > 0)) return;
                const role = this.roles[position.role];
                vacancies.push({
                    id: null,
                    title: `${position.name} (${grade})`,
                    position: position.id,
                    position_name: position.name,
                    role_id: position.role,
                    specialization: role?.specialization ?? position.role,
                    grade,
                    count,
                    task: this.positionTask(position.id),
                    requirements: this.requirements(d, position.id, grade, platforms),
                    assignments: [],
                    salary: null,
                    notes: null,
                });
            })
        );
        return vacancies;
    }

    // --- Для окна ------------------------------------------------------------------------

    // Каких обязательных ответов не хватает в разделе: тексты вопросов.
    missing(view: SectionView, answers: Answers, evaluation: Evaluation): string[] {
        const result: string[] = [];
        const { section, items } = view;
        if (items) {
            items.forEach((item) =>
                section.questions.forEach((question) => {
                    const scope = { item, section };
                    if (!question.required || !this.testIn(question.show_if, answers, scope)) return;
                    const value = this.templateValue(section, item, question, answers);
                    if (!isAnswered(question, value)) result.push(`${format(section.title, item.vars)}: ${format(question.text, item.vars)}`);
                })
            );
            return result;
        }
        section.questions.forEach((question) => {
            if (!evaluation.visible[question.id]) return;
            const value = answers[question.id];
            if (question.type === 'list') {
                const entries: any[] = Array.isArray(value) ? value : [];
                if (question.required && entries.length < (question.min_items ?? 1)) {
                    result.push(question.text);
                    return;
                }
                entries.forEach((entry, index) =>
                    (question.fields ?? []).forEach((field) => {
                        if (field.required && this.testIn(field.show_if, answers, { listItem: entry }) && !isAnswered(field, entry[field.id])) {
                            result.push(`${question.item_name ?? 'Элемент'} ${index + 1}: ${format(field.text, entry)}`);
                        }
                    })
                );
                return;
            }
            if (question.required && !isAnswered(question, value)) result.push(question.text);
            (question.validate ?? []).forEach((rule) => {
                if (!this.testIn(rule.rule, answers, {})) result.push(rule.message);
            });
        });
        return result;
    }

    // Ответы для записи: только видимые вопросы и блоки шаблонов, которые сейчас есть.
    cleanAnswers(answers: Answers, evaluation: Evaluation): Answers {
        const clean: Answers = {};
        Object.keys(this.statics).forEach((id) => {
            if (evaluation.visible[id] && answers[id] !== undefined) clean[id] = answers[id];
        });
        evaluation.sections
            .filter((view) => view.items)
            .forEach(({ section, items }) =>
                items!.forEach((item) =>
                    section.questions.forEach((question) => {
                        const value = this.templateValue(section, item, question, answers);
                        if (value !== undefined && value !== null) clean[templateKey(section, item, question)] = value;
                    })
                )
            );
        return clean;
    }

    // Сводка проекта для записи: что задано, что выбрано по рынку, команда, открытые вопросы.
    summary(evaluation: Evaluation, answers: Answers): { [key: string]: any } {
        return {
            stack_mode: evaluation.stackMode,
            kind_mode: evaluation.kindMode,
            mobile_variant: evaluation.mobileVariant?.id ?? null,
            positions: evaluation.positions.map(({ id, role, name }) => ({ id, role, name })),
            fixed_stack: evaluation.fixed.map(({ kind, id, positions, reasons }) => ({ kind, id, positions, reasons })),
            choices: evaluation.needs.map((need) => ({
                kind: need.kind,
                positions: need.positions,
                reasons: need.reasons,
                candidates: need.candidates.map((c) => c.key),
                chosen: need.chosen,
                recommended: need.recommended,
            })),
            team_plan: answers.team_plan ?? {},
            open_questions: evaluation.openQuestions,
        };
    }

    // План команды по умолчанию: по человеку уровня Middle на позицию, плюс советы suggest.
    defaultPlan(evaluation: Evaluation): Matrix {
        const plan: Matrix = {};
        evaluation.positions.forEach((position) => (plan[position.id] = { Middle: 1 }));
        const recommendations = this.schema.sections.find((s) => s.recommendations)?.recommendations ?? [];
        recommendations.forEach((rule) => {
            if (!rule.suggest || rule.for_each || !this.testIn(rule.when, this.answers, {})) return;
            const position = evaluation.positions.find((p) => p.role === rule.suggest!.role);
            if (position && rule.suggest.grade) {
                plan[position.id][rule.suggest.grade] = Math.max(plan[position.id][rule.suggest.grade] ?? 0, rule.suggest.min);
            }
        });
        return plan;
    }
}
