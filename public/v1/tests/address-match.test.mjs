// Address match rules (public/libraries/address-match/address-match.js): Google may complete a typed
// address with a city, state, ZIP or country, but it must not change the street line the person typed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const match = createRequire(import.meta.url)('../../libraries/address-match/address-match.js');
const google = (formatted_address, extra = {}) => ({ formatted_address, ...extra });

test('Google adding a city, state, ZIP or country is a match', () => {
  assert.equal(match.typedMismatch('123 Main St', google('123 Main St, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('123 Main St Denver', google('123 Main St, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('123 main st, denver co', google('123 Main St, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('123 Main St 80202', google('123 Main St, Denver, CO 80202, USA')), '');
});

test('Ave becoming St is not a match', () => {
  assert.equal(match.typedMismatch('123 Main Ave', google('123 Main St, Denver, CO 80202, USA')), 'street_changed');
  assert.equal(match.matchesTyped('123 Main Avenue, Denver', '123 Main St, Denver, CO 80202, USA'), false);
});

test('a street type or direction written out is the same as its abbreviation', () => {
  assert.equal(match.typedMismatch('123 Main Street', google('123 Main St, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('123 North Main Street', google('123 N Main St, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('450 Oak Boulevard Southwest', google('450 Oak Blvd SW, Atlanta, GA 30303, USA')), '');
  assert.equal(match.typedMismatch('123 S Main St', google('123 N Main St, Denver, CO 80202, USA')), 'street_changed');
});

test('a different house number is not a match', () => {
  assert.equal(match.typedMismatch('125 Main St', google('123 Main St, Denver, CO 80202, USA')), 'street_changed');
});

test('case, punctuation and extra spaces do not count', () => {
  assert.equal(match.typedMismatch('  123   MAIN st.,  Denver ', google('123 Main St, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch("12 O'Brien Rd", google('12 OBrien Rd, Austin, TX 78701, USA')), '');
});

test('unit and suite formatting is tolerated; a different unit is not', () => {
  assert.equal(match.typedMismatch('123 Main St Apt 4', google('123 Main St #4, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('123 Main St Unit 4', google('123 Main St Apt 4, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('123 Main St Suite 200, Denver', google('123 Main St Ste 200, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('123 Main St # 4', google('123 Main St, Denver, CO 80202, USA')), '', 'Google leaving the unit off');
  assert.equal(match.typedMismatch('123 Main St Apt 4', google('123 Main St #5, Denver, CO 80202, USA')), 'unit_changed');
});

test('Google adding to the street line, or changing the town typed, is not a match', () => {
  assert.equal(match.typedMismatch('123 Main', google('123 Main St, Denver, CO 80202, USA')), 'street_added');
  assert.equal(match.typedMismatch('123 Main St Boulder', google('123 Main St, Denver, CO 80202, USA')), 'locality_changed');
  assert.equal(match.typedMismatch('123 Main St 80203', google('123 Main St, Denver, CO 80202, USA')), 'locality_changed');
});

test('a state or country written out is the same as its abbreviation', () => {
  assert.equal(match.typedMismatch('123 Main St, Denver, Colorado', google('123 Main St, Denver, CO 80202, USA')), '');
  assert.equal(match.typedMismatch('9 Elm St Raleigh North Carolina United States', google('9 Elm St, Raleigh, NC 27601, USA')), '');
  assert.equal(match.typedMismatch('9 Elm St Miami FL 33101', google('9 Elm St, Miami, FL 33101, USA')), '', 'FL is Florida, not a floor');
});

test('a partial match, no answer or nothing typed is not a match', () => {
  assert.equal(match.typedMismatch('123 Main St', google('123 Main St, Denver, CO 80202, USA', { partial_match: true })), 'partial_match');
  assert.equal(match.typedMismatch('123 Main St', null), 'no_answer');
  assert.equal(match.typedMismatch('  ', google('123 Main St, Denver, CO 80202, USA')), 'nothing_typed');
});

test('two stored addresses name the same place', () => {
  assert.equal(match.sameAddress('123 Main St, Denver, CO 80202, USA', '123 Main Street, Denver, CO 80202'), true);
  assert.equal(match.sameAddress('123 Main St, Denver, CO 80202, USA', '123 Main St'), true);
  assert.equal(match.sameAddress('123 Main St, Denver, CO 80202, USA', '123 Main St, Boulder, CO 80302, USA'), false);
  assert.equal(match.sameAddress('123 Main St, Denver, CO 80202, USA', '123 Main Ave, Denver, CO 80202, USA'), false);
  assert.equal(match.sameAddress('123 Main St #4, Denver, CO', '123 Main St #5, Denver, CO'), false);
  assert.equal(match.sameAddress('', ''), false);
  assert.equal(match.streetLine('123 Main St, Denver, CO 80202, USA'), '123 Main St');
});

// Google's answer as the Geocoder gives it: the street is read from the components, because the
// formatted address can start with a place name.
const components = (number, route, routeShort, extra = []) => [
  { long_name:number, short_name:number, types:['street_number'] },
  { long_name:route, short_name:routeShort, types:['route'] },
  { long_name:'Mountain View', short_name:'Mountain View', types:['locality', 'political'] },
  { long_name:'Santa Clara County', short_name:'Santa Clara County', types:['administrative_area_level_2', 'political'] },
  { long_name:'California', short_name:'CA', types:['administrative_area_level_1', 'political'] },
  { long_name:'United States', short_name:'US', types:['country', 'political'] },
  { long_name:'94043', short_name:'94043', types:['postal_code'] },
  ...extra
];
const poi = google('Google Building 40, 1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA', { address_components:components('1600', 'Amphitheatre Parkway', 'Amphitheatre Pkwy') });

test('a Google answer whose formatted address starts with a place name is read from its components', () => {
  assert.equal(match.typedMismatch('1600 Amphitheatre Parkway, Mountain View', poi), '');
  assert.equal(match.typedMismatch('1600 amphitheatre pkwy mountain view ca 94043', poi), '');
  assert.equal(match.typedMismatch('1600 Amphitheatre Avenue, Mountain View', poi), 'street_changed');
  assert.equal(match.matchesTyped('1600 Amphitheatre, Mountain View', poi), false, 'Google adding the street type');
  assert.equal(match.typedMismatch('1600 Amphitheatre Parkway, Palo Alto', poi), 'locality_changed');
  const withUnit = google('1600 Amphitheatre Pkwy #4, Mountain View, CA 94043, USA', { address_components:components('1600', 'Amphitheatre Parkway', 'Amphitheatre Pkwy', [{ long_name:'4', short_name:'4', types:['subpremise'] }]) });
  assert.equal(match.typedMismatch('1600 Amphitheatre Pkwy Unit 4', withUnit), '');
  assert.equal(match.typedMismatch('1600 Amphitheatre Pkwy Unit 5', withUnit), 'unit_changed');
  assert.equal(match.streetLine(poi), '1600 Amphitheatre Pkwy', 'searched in Google\'s short form');
  assert.equal(match.sameAddress('1600 Amphitheatre Pkwy, Mountain View, CA 94043, USA', poi), true);
  assert.equal(match.sameAddress('1600 Amphitheatre Pkwy, Palo Alto, CA 94301, USA', poi), false);
});
