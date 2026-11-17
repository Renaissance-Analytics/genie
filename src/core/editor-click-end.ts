/**
 * A CLICK BELOW THE LAST LINE PUTS THE CURSOR AT THE END (beta.64). STUB: written in GREEN.
 */

export interface TextEnd { line: number; column: number }

export interface ClickLike {
    button: number;
    clientY: number;
    target: unknown;
    preventDefault(): void;
}

export interface TextareaLike {
    getBoundingClientRect(): { bottom: number };
}

export function endOfText(_value: string): TextEnd {
    return { line: 1, column: 1 };
}

export function clickToEnd(_click: ClickLike, _textarea: TextareaLike | null, _getValue: () => string, _setCursor: (pos: TextEnd) => void): boolean {
    return false;
}
