/**
 * /mail command - Show unread mails and recent read mails
 *
 * Unread mails: peek the mailbox file (not yet consumed by COLLECT state)
 * Read mails: scan the triologue for recent [MAIL] notes
 */

import type { SlashCommand } from '../types.js';
import chalk from 'chalk';

export const mailCommand: SlashCommand = {
  name: 'mail',
  description: 'Show unread and recent read mails',
  handler: (context) => {
    // 1. Unread mails — peek the mailbox (non-destructive)
    const unreadMails = context.ctx.mail.listMails();

    console.log(chalk.cyan.bold('\n=== Unread Mails'));
    if (unreadMails.length === 0) {
      console.log(chalk.gray('  (none)'));
    } else {
      console.log(chalk.gray(`  (${unreadMails.length} mail${unreadMails.length > 1 ? 's' : ''})\n`));
      for (let i = 0; i < unreadMails.length; i++) {
        const mail = unreadMails[i];
        console.log(chalk.white.bold(`  Mail #${i + 1} from ${mail.from}`));
        console.log(chalk.white(`  Title: ${mail.title}`));
        console.log(chalk.gray(`  Received: ${mail.timestamp.toLocaleString()}`));
        if (mail.issueId) {
          console.log(chalk.gray(`  Issue: #${mail.issueId}`));
        }
        console.log(chalk.gray('  ---'));
        console.log(`  ${mail.content.replace(/\n/g, '\n  ')}`);
        console.log();
      }
    }

    // 2. Read mails — scan triologue for [MAIL] notes (last 10)
    const triologue: { getMessagesRaw(): Array<{ role: string; content?: string }> } =
      context.triologue as unknown as { getMessagesRaw(): Array<{ role: string; content?: string }> };
    const messages = triologue.getMessagesRaw();

    const mailNotes = messages
      .filter(m => m.role === 'user' && m.content?.startsWith('[MAIL]'))
      .slice(-10);

    console.log(chalk.cyan.bold('=== Recent Read Mails'));
    if (mailNotes.length === 0) {
      console.log(chalk.gray('  (none)'));
    } else {
      console.log(chalk.gray(`  (last ${mailNotes.length} mail${mailNotes.length > 1 ? 's' : ''} in triologue)\n`));
      for (let i = 0; i < mailNotes.length; i++) {
        const note = mailNotes[i].content!;
        // Strip the [MAIL] prefix for cleaner display
        const body = note.replace(/^\[MAIL\]\s*/, '');
        console.log(`  ${body.replace(/\n/g, '\n  ')}`);
        if (i < mailNotes.length - 1) {
          console.log(chalk.gray('  ---'));
        }
      }
    }
    console.log();
  },
};
