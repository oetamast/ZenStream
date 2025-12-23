const { DateTime } = require('luxon');
const { shouldRetryOnFailure } = require('../services/runnerService');

function simulate(tier, hasEndAt = true) {
  const session = {
    id: `${tier}-${hasEndAt ? 'window' : 'open'}`,
    started_at: DateTime.utc().minus({ minutes: 5 }).toISO(),
    target_end_at: hasEndAt ? DateTime.utc().plus({ minutes: 30 }).toISO() : null,
  };
  const decision = shouldRetryOnFailure({ license_tier: tier }, session);
  const windowLabel = hasEndAt ? 'bounded window' : 'open-ended';
  console.log(`Tier=${tier} (${windowLabel}) -> ${decision.retry ? 'retry' : `fail (${decision.reason})`}`);
}

simulate('basic', true);
simulate('basic', false);
simulate('premium', true);
simulate('premium', false);
simulate('ultimate', true);
simulate('ultimate', false);
