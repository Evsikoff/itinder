import React from 'react';
import { SignIcon } from './GradeTasks';

// Общие части окна «Проекты и вакансии»: флажок и переключатель Windows 95,
// окно сообщения, склонения и форматы. Классы — GradeTasks.css и ProjectsVacancies.css.

export type Sign = 'ok' | 'error' | 'info' | 'question';

export interface DialogButton {
    text: string;
    onClick: () => void;
    primary?: boolean;
}

export interface Dialog {
    sign: Sign;
    title: string;
    text: string;
    list?: string[]; // перечень под текстом: чего не хватает, что будет удалено
    input?: { label: string; value: string; maxLength: number }; // поле ввода (название копии)
    buttons: DialogButton[];
}

const CheckMark: React.FC = () => (
    <svg width="9" height="9" viewBox="0 0 9 9" aria-hidden="true">
        <polyline points="1.5,4 3.5,6.5 7.5,2" fill="none" stroke="#000" strokeWidth="2" />
    </svg>
);

// Строка с флажком или переключателем: щелчок по строке переключает, пробел и Enter — тоже.
export const Choice: React.FC<{
    type: 'check' | 'radio';
    checked: boolean;
    onToggle: () => void;
    label: React.ReactNode;
    hint?: React.ReactNode;
    disabled?: boolean;
    compact?: boolean;
}> = ({ type, checked, onToggle, label, hint, disabled, compact }) => (
    <div
        className={
            'pv-choice' + (checked ? ' pv-choice-on' : '') + (disabled ? ' pv-choice-disabled' : '') + (compact ? ' pv-choice-compact' : '')
        }
        role={type === 'check' ? 'checkbox' : 'radio'}
        aria-checked={checked}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && onToggle()}
        onKeyDown={(event) => {
            if (disabled || (event.key !== ' ' && event.key !== 'Enter')) return;
            event.preventDefault();
            onToggle();
        }}
    >
        <div className={type === 'check' ? 'gt-check' : 'pv-radio'}>
            {checked && (type === 'check' ? <CheckMark /> : <div className="pv-radio-dot" />)}
        </div>
        <div className="gt-column pv-choice-text">
            <span>{label}</span>
            {hint && <span className="gt-muted pv-small">{hint}</span>}
        </div>
    </div>
);

export const DialogView: React.FC<{ dialog: Dialog; onInput?: (value: string) => void }> = ({ dialog, onInput }) => (
    <div className="gt-modal">
        <div className="gt-dialog pv-dialog" role="alertdialog" aria-modal="true" aria-label={dialog.title}>
            <div className="gt-dialog-title">
                <span>{dialog.title}</span>
            </div>
            <div className="gt-dialog-body">
                <SignIcon sign={dialog.sign} />
                <div className="gt-column" style={{ marginLeft: 16, flex: 1 }}>
                    <p>{dialog.text}</p>
                    {dialog.list && (
                        <ul className="gt-facts pv-dialog-list">
                            {dialog.list.map((line, index) => (
                                <li key={index}>{line}</li>
                            ))}
                        </ul>
                    )}
                    {dialog.input && (
                        <label className="gt-column" style={{ marginTop: 10 }}>
                            <span>{dialog.input.label}</span>
                            <input
                                className="pv-input"
                                value={dialog.input.value}
                                maxLength={dialog.input.maxLength}
                                autoFocus
                                onChange={(event) => onInput?.(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') dialog.buttons.find((b) => b.primary)?.onClick();
                                }}
                            />
                        </label>
                    )}
                </div>
            </div>
            <div className="gt-dialog-buttons">
                {dialog.buttons.map((button) => (
                    <button
                        key={button.text}
                        className={'site-button' + (button.primary ? ' gt-default' : '')}
                        onClick={button.onClick}
                        autoFocus={button.primary && !dialog.input}
                    >
                        {button.text}
                    </button>
                ))}
            </div>
        </div>
    </div>
);

export function plural(count: number, one: string, few: string, many: string): string {
    const tens = count % 100;
    const units = count % 10;
    if (units === 1 && tens !== 11) return one;
    if (units >= 2 && units <= 4 && (tens < 12 || tens > 14)) return few;
    return many;
}

export const peopleWord = (count: number) => plural(count, 'человек', 'человека', 'человек');
export const vacanciesWord = (count: number) => plural(count, 'вакансия', 'вакансии', 'вакансий');
export const applicantsWord = (count: number) => plural(count, 'соискатель', 'соискателя', 'соискателей');

// «120 000 ₽».
export function money(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    return `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
}

// «9 октября 2026».
export function formatDate(iso: string | null | undefined): string {
    const date = new Date(iso ?? '');
    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }).replace(/\s*г\.$/, '');
}
