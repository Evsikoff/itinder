import questionnaire from '../../app/db/project_questionnaire.json';
import stack from '../../app/db/fsp_stack.json';
import roles from '../../app/db/fsp_team_roles.json';
import { Answers, Applicant, QuestionnaireEngine, QuestionnaireSchema, StackCatalog, TeamRole, templateKey } from './projectQuestionnaire';

// Рынок: React Native выигрывает у Flutter по числу соискателей.
const market: Applicant[] = [
    { role: 'frontend', grade: 'Middle', competencies: { 'languages:dart': 2 } },
    { role: 'frontend', grade: 'Middle', competencies: { 'languages:typescript': 2 } },
    { role: 'frontend', grade: 'Middle', competencies: { 'languages:typescript': 3 } },
    { role: 'frontend', grade: 'Senior', competencies: { 'languages:typescript': 3 } },
];

function engine(): QuestionnaireEngine {
    return new QuestionnaireEngine({
        schema: questionnaire as unknown as QuestionnaireSchema,
        stack: stack as unknown as StackCatalog,
        roles: roles as unknown as TeamRole[],
        market,
    });
}

// Действующий проект с кроссплатформенным мобильным приложением и заданным стеком.
function existingProject(clients: string[], languages: string[], extra: Answers = {}): Answers {
    return {
        stage: 'active',
        clients,
        mobile_native: 'cross',
        existing_stack: { languages, databases: ['postgresql'], integrations: ['rest'] },
        team_plan: { backend_main: { Middle: 1 }, frontend_web: { Middle: 1 }, frontend_mobile: { Middle: 1 } },
        ...extra,
    };
}

const MOBILE_BLOCKER = 'в заданном стеке нет языков мобильной разработки';

describe('QuestionnaireEngine: мобильное приложение при заданном стеке', () => {
    it('Dart в стеке мобильного проекта — Flutter и вакансия мобильного разработчика', () => {
        const evaluation = engine().evaluate(existingProject(['android', 'ios'], ['python', 'dart', 'sql']));

        expect(evaluation.kindMode.languages).toBe('fixed');
        expect(evaluation.mobileVariant?.id).toBe('flutter');
        const mobile = evaluation.positions.find((p) => p.id === 'frontend_mobile');
        expect(mobile?.name).toBe('Мобильный разработчик (Flutter)');
        expect(evaluation.fixed.find((item) => item.id === 'dart')?.positions).toEqual(['frontend_mobile']);
        expect(evaluation.choices).toEqual([]);
        expect(evaluation.openQuestions.map((q) => q.text).join('\n')).not.toMatch(MOBILE_BLOCKER);
        expect(evaluation.openQuestions.filter((q) => q.blocking)).toEqual([]);

        const vacancy = evaluation.vacancies.find((v) => v.position === 'frontend_mobile');
        expect(vacancy?.title).toBe('Мобильный разработчик (Flutter) (Middle)');
        const dart = vacancy?.requirements.find((row) => row.kind === 'languages' && row.ids.includes('dart'));
        expect(dart).toMatchObject({ ids: ['dart'], importance: 'required', origin: 'fixed' });
    });

    it('TypeScript в стеке веб- и мобильного проекта — React Native рядом с веб-фронтендом', () => {
        const evaluation = engine().evaluate(existingProject(['web', 'android', 'ios'], ['python', 'typescript', 'sql']));

        expect(evaluation.mobileVariant?.id).toBe('react_native');
        expect(evaluation.positions.map((p) => p.id)).toEqual(
            expect.arrayContaining(['backend_main', 'frontend_web', 'frontend_mobile'])
        );
        expect(evaluation.positions.find((p) => p.id === 'frontend_mobile')?.name).toBe('Мобильный разработчик (React Native)');
        expect(evaluation.fixed.find((item) => item.id === 'typescript')?.positions).toEqual(['frontend_web', 'frontend_mobile']);
        expect(evaluation.choices).toEqual([]);
        expect(evaluation.vacancies.map((v) => v.position)).toEqual(
            expect.arrayContaining(['backend_main', 'frontend_web', 'frontend_mobile'])
        );
    });

    it('Dart и TypeScript в стеке — выбор между Flutter и React Native, по умолчанию первый по rules.mobile_variants', () => {
        const qe = engine();
        const answers = existingProject(['web', 'android', 'ios'], ['python', 'dart', 'typescript']);
        const evaluation = qe.evaluate(answers);

        expect(evaluation.choices).toHaveLength(1);
        const need = evaluation.choices[0];
        expect(need.variants).toBe(true);
        expect(need.candidates.map((c) => c.key).sort()).toEqual(['flutter', 'react_native']);
        // Код уже написан: число соискателей (у React Native их больше) не решает.
        expect(need.recommended).toBe('flutter');
        expect(evaluation.mobileVariant?.id).toBe('flutter');
        expect(evaluation.positions.find((p) => p.id === 'frontend_mobile')?.name).toBe('Мобильный разработчик (Flutter)');

        const section = qe.schema.sections.find((s) => s.repeat === 'market_choices')!;
        const key = templateKey(section, qe.choiceItem(need), section.questions[0]);
        const chosen = qe.evaluate({ ...answers, [key]: ['react_native'] });
        expect(chosen.mobileVariant?.id).toBe('react_native');
        expect(chosen.positions.find((p) => p.id === 'frontend_mobile')?.name).toBe('Мобильный разработчик (React Native)');
    });

    it('без мобильного языка в стеке — блокирующий вопрос техлиду и нет мобильной позиции', () => {
        const evaluation = engine().evaluate(existingProject(['android', 'ios'], ['python', 'sql']));

        expect(evaluation.mobileVariant).toBeNull();
        expect(evaluation.positions.map((p) => p.id)).not.toContain('frontend_mobile');
        const blocker = evaluation.openQuestions.find((q) => q.text.includes(MOBILE_BLOCKER));
        expect(blocker?.blocking).toBe(true);
    });

    it('«неважно» и Kotlin со Swift в стеке — нативные приложения', () => {
        const evaluation = engine().evaluate(
            existingProject(['android', 'ios'], ['python', 'kotlin', 'swift'], { mobile_native: 'any' })
        );

        expect(evaluation.mobileVariant?.id).toBe('native');
        expect(evaluation.positions.map((p) => p.id)).toEqual(expect.arrayContaining(['frontend_android', 'frontend_ios']));
        expect(evaluation.positions.map((p) => p.id)).not.toContain('frontend_mobile');
        expect(evaluation.openQuestions.map((q) => q.text).join('\n')).not.toMatch(MOBILE_BLOCKER);
    });
});
