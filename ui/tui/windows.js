import { ChoiceList } from './choice-list/index.js';
import { Confirm } from './confirm/index.js';
import { Prompt } from './prompt/index.js';

/**
 * The component that draws each kind of window, by its handler's kind — `ui/tui/<handler-name>/`. A window
 * of a kind missing here is drawn as a placeholder naming it.
 * @type {{ [kind: string]: import('./common/windows/windows.jsx').WindowComponent }}
 */
export const windows = { confirm: Confirm, prompt: Prompt, choiceList: ChoiceList };
