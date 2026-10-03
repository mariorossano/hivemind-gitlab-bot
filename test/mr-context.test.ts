import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mrChannelName, mrHeading, mrTitle } from '../src/mr-context.ts';

test('MR channel names put the subject before the project discriminator',()=>{
  assert.equal(mrChannelName(42,7,'Draft: feat(APP-123): adopt the scene lifecycle'),
    'mr-7-adopt-the-scene-lifecycle-p42');
  assert.equal(mrChannelName(42,8,'APP-124 [iOS] Add Rewards tab'), 'mr-8-add-rewards-tab-p42');
  assert.equal(mrChannelName(42,8,'WIP: fix!: café / checkout & payment'), 'mr-8-cafe-checkout-payment-p42');
});
test('names remain bounded ASCII slugs with distinct MR and project identities',()=>{
  for(const title of ['', '🎉 東京', '---', 'Fix '.repeat(500), 'a'.repeat(4000), 'x'.repeat(80)+' end']) {
    const name=mrChannelName(42,7,title);
    assert.ok(name.length<=100);assert.match(name,/^mr-7-[a-z0-9]+(?:-[a-z0-9]+)*-p42$/);
    assert.notEqual(name,mrChannelName(43,7,title));assert.notEqual(name,mrChannelName(42,8,title));
  }
  assert.equal(mrChannelName(42,7,'🎉 東京'),'mr-7-merge-request-p42');
  assert.ok(mrChannelName(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,'a'.repeat(500)).length<=100);
});
test('display titles keep ticket context but normalize whitespace and bound long headings',()=>{
  assert.equal(mrHeading(7,'feat(APP-123):\n adopt\t scene\u202e lifecycle'),
    'MR !7 · feat(APP-123): adopt scene lifecycle');
  assert.equal(mrTitle('   '),'Untitled merge request');
  assert.equal(mrTitle('x'.repeat(241)),'x'.repeat(239)+'…');
  assert.equal(mrTitle('x'.repeat(401),400),'x'.repeat(399)+'…');
});
