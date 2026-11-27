const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const data = JSON.parse(scripts.find(([, attrs]) => attrs.includes('id="route-data"'))[2]);
const runtime = scripts.find(([, attrs, source]) => !attrs.trim() && source.includes('function createStampPlanner('))[2];
// Load the page's definitions and constants, stopping before its browser UI bootstrap.
const bootstrap = runtime.search(/^\s*\(\(\)\s*=>\s*\{/m);
assert.ok(bootstrap > 0);
const api = vm.runInNewContext(runtime.slice(0, bootstrap) + `
  ({ createStampPlanner, defaultReservation, stampReservationStatus, reservationDisplayEntry, reservationHint,
     validatedReservation, reservationDayError, reservationStartMinute })
`, { Path2D: class {} });
const { createStampPlanner, defaultReservation, stampReservationStatus, reservationDisplayEntry, reservationHint,
  validatedReservation, reservationDayError, reservationStartMinute } = api;
const planner = createStampPlanner(data);
const activities = data.calendar.activities;
const byName = new Map(activities.map((activity) => [activity.name, activity]));
const ownAllExcept = (...names) => activities.map((activity) => activity.name).filter((name) => !names.includes(name));
const blocks = (day) => day.stops.flatMap((stop) => stop.blocks);

test('the stamp clock distinguishes published openings from saved registrations', () => {
  const status = (name, localTime, saved) => stampReservationStatus(byName.get(name), saved, localTime);
  assert.equal(status('图图犬', '2026-11-27T14:59:59'), 'none');
  assert.equal(status('图图犬', '2026-11-27T15:00:00'), 'open');
  assert.equal(status('皮卡丘', '2026-11-25T14:59:59'), 'none');
  assert.equal(status('皮卡丘', '2026-11-25T15:00:00'), 'open');
  assert.equal(status('闪电鸟', '2026-11-26T00:00:00'), 'open');
  assert.equal(status('闪电鸟', '2026-12-20T23:59:59'), 'open');
  assert.equal(status('闪电鸟', '2026-12-21T00:00:00'), 'none');
  assert.equal(status('雪吞虫', '2026-12-22T10:00:00'), 'none');
  assert.equal(status('古月鸟', '2026-12-10T10:00:00'), 'none');
  const registration = { date: '2026-12-12', time: '10:00' };
  assert.equal(status('图图犬', '2026-12-11T15:00:00', registration), 'booked');
  assert.equal(status('图图犬', '2026-12-22T15:00:00', registration), 'booked');
});

test('calendar and route hints distinguish open, booked and ordinary activities', () => {
  const current = '2026-12-12T09:00:00';
  const activity = byName.get('皮卡丘');
  const booked = reservationDisplayEntry(activity, { date: '2026-12-13', time: '14:10' }, current);
  assert.match(reservationHint(booked), /已预约 12\/13 14:10 开始/);
  assert.match(reservationHint(booked), /14:00 报到/);
  const midnight = reservationDisplayEntry(activity, { date: '2026-12-13', time: '00:05' }, current);
  assert.match(reservationHint(midnight), /12\/12 23:55 报到/);
  const open = reservationDisplayEntry(activity, null, current);
  assert.match(reservationHint(open), /已开放预约，尚未登记场次/);
  assert.equal(reservationHint(reservationDisplayEntry(byName.get('古月鸟'), null, current)), '');
});

test('new bookings default to Shanghai tomorrow at ten within the activity window', () => {
  const activity = { start: '2026-12-30', end: '2027-01-02' };
  for (const [instant, expected] of [
    ['2026-12-28T15:59:00Z', '2026-12-30'],
    ['2026-12-29T15:59:00Z', '2026-12-30'],
    ['2026-12-29T16:00:00Z', '2026-12-31'],
    ['2026-12-31T08:00:00Z', '2027-01-01'],
    ['2027-01-02T08:00:00Z', '2027-01-02'],
    ['2027-01-03T08:00:00Z', '2027-01-02'],
  ]) {
    const slot = defaultReservation(activity, Date.parse(instant));
    assert.equal(slot.date, expected);
    assert.equal(slot.time, '10:00');
  }
});

test('booked workshops, tournaments and the exhibition keep the session time and ten-minute check-in', () => {
  const date = '2026-12-12';
  for (const [name, duration] of [['图图犬', 60], ['闪电鸟', 120], ['皮卡丘', 70]]) {
    const reservations = { [byName.get(name).id]: { date, time: '14:20' } };
    const options = { reservations, owned: ownAllExcept(name), target: 'all' };
    for (const strategy of ['easy', 'direct', 'preferred', 'fan']) {
      const day = planner.planForDate({ ...options, date, strategy }).days[0];
      assert.equal(day.count, 1);
      const [block] = blocks(day);
      assert.equal(block.activity.name, name);
      assert.equal(block.reserved, true);
      assert.equal(block.checkInStartMinute, 850);
      assert.equal(block.checkInMinutes, 10);
      assert.equal(block.startMinute, 860);
      assert.equal(block.endMinute, 860 + duration);
    }
    assert.equal(planner.planForDate({ ...options, date: '2026-12-13' }).count, 0);
  }
});

test('the registration form and planner agree on same-day session boundaries and can still read legacy registrations', () => {
  const date = '2026-12-12';
  for (const [name, latest, overrun] of [
    ['图图犬', '23:00', '23:01'], ['皮卡丘', '22:50', '22:51'], ['闪电鸟', '22:00', '22:01'],
  ]) {
    const activity = byName.get(name);
    const owned = ownAllExcept(name);
    for (const [time, error] of [
      ['00:00', /报到会跨到前一天/], ['00:09', /报到会跨到前一天/], [overrun, /结束时间会跨到次日/],
      ['00:10', null], [latest, null],
    ]) {
      const slot = { date, time };
      assert.equal(validatedReservation(activity, slot)?.time, time, 'even an old out-of-bounds registration remains readable');
      const message = reservationDayError(activity, reservationStartMinute(time));
      const options = { date, fromDate: date, target: 'all', owned, reservations: { [activity.id]: slot } };
      for (const plan of [planner.planForDate(options), planner.recommend(options)]) {
        if (error) {
          assert.match(message, error);
          assert.ok(plan.reservationConflicts.some((text) => text.includes(message)));
          assert.equal(plan.days.length, 0);
        } else {
          assert.equal(message, '');
          const [block] = blocks(plan.days[0]);
          assert.equal(block.startMinute, reservationStartMinute(time));
          assert.equal(block.checkInStartMinute, block.startMinute - 10);
          assert.ok(block.checkInStartMinute >= 0 && block.endMinute <= 1440);
        }
      }
    }
  }
});

test('all multi-day alternatives retain confirmed sessions, including when the reward is already earned', () => {
  const fixed = [['皮卡丘', '2026-11-28', '14:00', 840], ['闪电鸟', '2026-11-29', '13:30', 810]];
  const reservations = Object.fromEntries(fixed.map(([name, date, time]) => [byName.get(name).id, { date, time }]));
  const owned = ownAllExcept('皮卡丘', '闪电鸟', '啃果虫', '惊角鹿', '信使鸟', '盆才怪');
  for (const target of ['all', 3]) {
    const plan = planner.recommend({ reservations, owned, target, fromDate: '2026-11-28' });
    if (target === 'all') assert.ok(plan.alternatives.length, 'exercise a real alternative');
    else assert.equal(plan.count, 2);
    for (const option of [plan, ...plan.alternatives]) {
      for (const [name, date, , minute] of fixed) {
        const matches = option.days.flatMap((day) => blocks(day).filter((block) => block.activity.name === name)
          .map((block) => ({ date: day.date, start: block.startMinute })));
        assert.equal(matches.length, 1);
        assert.equal(matches[0].date, date);
        assert.equal(matches[0].start, minute);
      }
    }
  }
});

test('incompatible check-ins produce a visible conflict in both planners', () => {
  const date = '2026-12-12';
  const reservations = {
    [byName.get('闪电鸟').id]: { date, time: '14:00' },
    [byName.get('火焰鸟').id]: { date, time: '15:00' },
  };
  for (const plan of [planner.planForDate({ reservations, date }), planner.recommend({ reservations, fromDate: date })]) {
    assert.equal(plan.days.length, 0);
    assert.match(plan.reservationConflicts.join(' '), /火焰鸟.*14:50.*报到/);
  }
});

test('removing the last booking restores flexible scheduling and dates without activities return an empty plan', () => {
  const id = byName.get('图图犬').id;
  const options = { owned: ownAllExcept('图图犬'), target: 'all', date: '2026-12-13' };
  const reservations = { [id]: { date: '2026-12-12', time: '14:00' } };
  assert.equal(planner.planForDate({ ...options, reservations }).count, 0);
  delete reservations[id];
  const restored = planner.planForDate({ ...options, reservations });
  assert.equal(restored.count, 1);
  assert.equal(blocks(restored.days[0])[0].activity.name, '图图犬');
  assert.equal(JSON.stringify(restored), JSON.stringify(planner.planForDate(options)));
  assert.equal(planner.planForDate({ ...options, reservations, date: '2027-01-04' }).count, 0);
});
