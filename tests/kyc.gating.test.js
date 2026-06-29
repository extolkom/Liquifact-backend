const { CAPITAL_MOVING_STATES } = require('../src/services/invoiceStateMachine');

describe('Structural Compliance - Capital Movement KYC Verification', () => {
    it('should strictly gate known high-risk transaction lifecycle states', () => {
        expect(CAPITAL_MOVING_STATES.has('funded')).toBe(true);
        expect(CAPITAL_MOVING_STATES.has('settled')).toBe(true);
    });
});
