import { Box, Text } from 'ink';
import { init } from '../../handler.js';
import { useSelector } from '../store/index.js';

/**
 * @typedef {import('../../../../src/messages.js').Message} Message
 * @typedef {import('../../../../src/messages.js').MessageLevel} MessageLevel
 */

/** @type {Message[]} */
const NONE = [];

/** @type {{ [level in MessageLevel]: string | undefined }} */
const COLORS = { error: 'red', warning: 'yellow', info: undefined };

/** Rows the popup keeps for its border, title, and footer. */
const POPUP_CHROME = 6;

/**
 * The messages to show, from `core`'s state (`src/messages.js`).
 * @returns {Message[]}
 */
export function useMessages() {
  return useSelector(init('core').store, (state) => state.messages ?? NONE);
}

/**
 * @param {Message} message
 * @returns {string} Its text, with how many times it came if more than once.
 */
function label(message) {
  return message.count > 1 ? `${message.text} (×${message.count})` : message.text;
}

/**
 * Whether the messages need the popup: more than one, or one that doesn't fit on the bottom line.
 * @param {Message[]} messages
 * @param {number} columns The terminal's width.
 * @returns {boolean}
 */
export function needsPopup(messages, columns) {
  if (messages.length !== 1) {
    return messages.length > 1;
  }
  const text = label(messages[0]);
  return text.includes('\n') || [...text].length > columns;
}

/**
 * The bottom line: a message, when there's one that fits. It stays until the next key press, which also
 * does its usual job.
 * @param {object} props
 * @param {number} props.columns The terminal's width.
 */
export function MessageLine({ columns }) {
  const messages = useMessages();
  const message = messages.length && !needsPopup(messages, columns) ? messages[0] : null;
  return (
    <Box height={1} flexShrink={0}>
      {message && (
        <Text color={COLORS[message.level]} wrap="truncate-end">
          {label(message)}
        </Text>
      )}
    </Box>
  );
}

/**
 * The popup over everything, for messages that don't fit the bottom line: the latest ones that fit on
 * screen, oldest first. Any key dismisses it and does nothing else (`useKeybindings`).
 * @param {object} props
 * @param {number} props.columns The terminal's width.
 * @param {number} props.rows The terminal's height.
 */
export function MessagePopup({ columns, rows }) {
  const messages = useMessages();
  if (!needsPopup(messages, columns)) {
    return null;
  }
  const shown = messages.slice(-Math.max(1, rows - POPUP_CHROME));
  const hidden = messages.length - shown.length;
  const color = messages.some((message) => message.level === 'error')
    ? COLORS.error
    : messages.some((message) => message.level === 'warning') ? COLORS.warning : undefined;
  const title = messages.length === 1 ? capitalize(messages[0].level) : `${messages.length} messages`;
  return (
    <Box position="absolute" width="100%" height="100%" justifyContent="center" alignItems="center">
      <Box
        backgroundColor="blank"
        borderStyle="round"
        borderColor={color}
        flexDirection="column"
        paddingX={1}
        maxWidth={Math.max(20, columns - 4)}
      >
        <Text bold color={color}>
          {title}
        </Text>
        {hidden > 0 && <Text dimColor>…{hidden} earlier not shown</Text>}
        {shown.map((message) => (
          <Text key={message.id} color={COLORS[message.level]}>
            {label(message)}
          </Text>
        ))}
        <Text dimColor>Press any key</Text>
      </Box>
    </Box>
  );
}

/**
 * @param {string} text
 * @returns {string}
 */
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
