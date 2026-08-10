import { loadSocial } from '../src/config';
import { Poster } from '../src/social/poster';
import { Tracker } from '../src/track/tracker';
import { isPublished, peakMultiple } from '../src/social/recap';
import { tweetLength, TWEET_LIMIT, loadCredentials } from '../src/social/x';

/**
 * Shows what the X feed would post right now, without posting it. The account is the growth
 * engine, so being able to read a week of it before any of it is public matters more than
 * the convenience of just letting it run.
 */
function main() {
  const social = loadSocial();
  const calls = Tracker.read();

  if (!calls.length) {
    console.log('\n  Nothing tracked yet — run the bot and make some calls first.\n');
    return;
  }

  const published = calls.filter(isPublished);
  const withPeak = published.filter((c) => peakMultiple(c) !== undefined);
  console.log(`\n  ${calls.length} tracked · ${published.length} actually called · ${withPeak.length} priced`);

  if (published.length < calls.length) {
    // Worth stating plainly, because it is the one rule that keeps the account credible.
    console.log('  (shadow and dry-run calls are never posted — we did not make them)');
  }

  // Loading the sent history is what makes this a preview of the *next* posts rather than a
  // list of everything that ever qualified. Before going live the history is empty, so this
  // still shows the whole backlog.
  const poster = new Poster({ ...social, dailyRecap: social.dailyRecap });
  poster.load();

  const posts = poster.due(calls);
  if (!posts.length) {
    console.log(`\n  nothing due. Milestone floor is ${social.minMultiple}x.\n`);
    return;
  }

  console.log(`\n  ${posts.length} post(s) due:\n`);
  for (const post of posts) {
    const length = tweetLength(post.text);
    const over = length > TWEET_LIMIT ? ' ⚠️  TOO LONG' : '';
    console.log(`  ┌─ ${post.key} · ${length}/${TWEET_LIMIT}${over}`);
    for (const line of post.text.split('\n')) console.log(`  │ ${line}`);
    console.log('  └─\n');
  }

  if (!social.channelUrl) console.log('  ⚠️  CHANNEL_URL is unset, so no post links back to the channel.');
  if (!loadCredentials()) console.log('  ⚠️  X credentials unset — these are previews, nothing will be posted.');
  console.log('');
}

main();
