import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ItemRarity } from './types.ts';
import {
  parseExterior,
  parsePriceOverview,
  parseSearchResponse,
  parseSteamPrice,
  parseSteamRarity,
  parseWeaponType,
  steamCurrencyCode,
  toSearchQuery,
} from './steam-market.ts';

test('dollar price', () => {
  assert.equal(parseSteamPrice('$86.96'), 8696);
  assert.equal(parseSteamPrice('$0.03'), 3);
  assert.equal(parseSteamPrice('$1,234.56'), 123_456);
});

test('rouble price with a comma as the decimal separator', () => {
  assert.equal(parseSteamPrice('3225,06 руб.'), 322_506);
  assert.equal(parseSteamPrice('7,50 руб.'), 750);
});

test('price with a period as the thousands separator', () => {
  assert.equal(parseSteamPrice('1.234,56€'), 123_456);
  assert.equal(parseSteamPrice('12.345,00 pуб.'), 1_234_500);
});

test('a currency without minor units parses as a whole number', () => {
  // Won and yen have no minor unit: "₩ 12,500" is 12,500 won, not 125.
  assert.equal(parseSteamPrice('₩ 12,500'), 1_250_000);
  assert.equal(parseSteamPrice('¥ 980'), 98_000);
});

test('a missing price returns null, not zero', () => {
  // Zero would make the item free and drag the case RTP down.
  assert.equal(parseSteamPrice(null), null);
  assert.equal(parseSteamPrice(''), null);
  assert.equal(parseSteamPrice('not for sale'), null);
  assert.equal(parseSteamPrice(undefined), null);
});

test('rarity from the item type', () => {
  assert.equal(parseSteamRarity('Consumer Grade Pistol'), ItemRarity.CONSUMER);
  assert.equal(parseSteamRarity('Industrial Grade SMG'), ItemRarity.INDUSTRIAL);
  assert.equal(parseSteamRarity('Mil-Spec Grade Rifle'), ItemRarity.MILSPEC);
  assert.equal(parseSteamRarity('Restricted Pistol'), ItemRarity.RESTRICTED);
  assert.equal(parseSteamRarity('Classified Rifle'), ItemRarity.CLASSIFIED);
  assert.equal(parseSteamRarity('Covert Rifle'), ItemRarity.COVERT);
});

// A search asked in Russian answers with a Russian type string. Reading only
// English out of it files the whole catalogue as Consumer Grade, which is how
// the first run of the catalogue importer silently flattened every rarity.
test('rarity from a localised item type', () => {
  assert.equal(parseSteamRarity('Пистолет, Ширпотреб'), ItemRarity.CONSUMER);
  assert.equal(parseSteamRarity('Дробовик, Промышленное качество'), ItemRarity.INDUSTRIAL);
  assert.equal(parseSteamRarity('Пистолет-пулемёт, Армейское качество'), ItemRarity.MILSPEC);
  assert.equal(parseSteamRarity('Винтовка, Запрещённое'), ItemRarity.RESTRICTED);
  assert.equal(parseSteamRarity('Пистолет, Засекреченное'), ItemRarity.CLASSIFIED);
  assert.equal(parseSteamRarity('Винтовка, Тайное'), ItemRarity.COVERT);
  assert.equal(parseSteamRarity('Перчатки, Экстраординарное'), ItemRarity.EXTRAORDINARY);
});

// "Запрещённое" and "Засекреченное" share four letters; a prefix match would
// collapse Restricted into Classified.
test('localised Restricted and Classified are told apart', () => {
  assert.equal(parseSteamRarity('Винтовка, Запрещенное'), ItemRarity.RESTRICTED);
  assert.equal(parseSteamRarity('Винтовка, Засекреченное'), ItemRarity.CLASSIFIED);
});

test('StatTrak and Souvenir do not change the rarity', () => {
  assert.equal(parseSteamRarity('StatTrak™ Classified Rifle'), ItemRarity.CLASSIFIED);
  assert.equal(parseSteamRarity('Souvenir Restricted Rifle'), ItemRarity.RESTRICTED);
});

test('starred knives and gloves are the top tier', () => {
  assert.equal(parseSteamRarity('★ Covert Knife'), ItemRarity.EXTRAORDINARY);
  assert.equal(parseSteamRarity('★ Extraordinary Gloves'), ItemRarity.EXTRAORDINARY);
  assert.equal(parseSteamRarity('★ StatTrak™ Covert Knife'), ItemRarity.EXTRAORDINARY);
});

test('contraband is the top tier', () => {
  assert.equal(parseSteamRarity('Contraband Rifle'), ItemRarity.EXTRAORDINARY);
});

test('an unknown type does not break parsing', () => {
  assert.equal(parseSteamRarity('Base Grade Container'), ItemRarity.CONSUMER);
  assert.equal(parseSteamRarity(null), ItemRarity.CONSUMER);
  assert.equal(parseSteamRarity(''), ItemRarity.CONSUMER);
});

test('exterior from the name', () => {
  assert.equal(parseExterior('AK-47 | Redline (Field-Tested)'), 'Field-Tested');
  assert.equal(parseExterior('★ Karambit | Doppler (Factory New)'), 'Factory New');
});

test('an item without an exterior', () => {
  assert.equal(parseExterior('Operation Bravo Case'), null);
  // There are parentheses, but they are not an exterior.
  assert.equal(parseExterior('Sticker | Titan (Holo) | Katowice 2014'), null);
});

test('weapon type', () => {
  assert.equal(parseWeaponType('StatTrak™ Classified Rifle'), 'Rifle');
  assert.equal(parseWeaponType('★ Covert Knife'), 'Knife');
  assert.equal(parseWeaponType(null), null);
});

test('currency code', () => {
  assert.equal(steamCurrencyCode('RUB'), 5);
  assert.equal(steamCurrencyCode('usd'), 1);
  // An unknown currency must not break the request — fall back to dollars.
  assert.equal(steamCurrencyCode('XYZ'), 1);
});

test('search response parsing', () => {
  const payload = {
    success: true,
    results: [
      {
        name: 'AK-47 | Redline (Field-Tested)',
        hash_name: 'AK-47 | Redline (Field-Tested)',
        sell_price: 1234,
        sell_listings: 42,
        asset_description: {
          icon_url: 'ICONHASH',
          type: 'Classified Rifle',
          market_hash_name: 'AK-47 | Redline (Field-Tested)',
        },
      },
    ],
  };

  const [item] = parseSearchResponse(payload);
  assert.ok(item);
  assert.equal(item.marketHashName, 'AK-47 | Redline (Field-Tested)');
  assert.equal(item.rarity, ItemRarity.CLASSIFIED);
  assert.equal(item.weaponType, 'Rifle');
  assert.equal(item.exterior, 'Field-Tested');
  assert.equal(item.referencePriceUsd, 1234);
  assert.equal(item.listings, 42);
  assert.match(item.imageUrl ?? '', /economy\/image\/ICONHASH/);
});

test('a malformed search response does not break parsing', () => {
  assert.deepEqual(parseSearchResponse(null), []);
  assert.deepEqual(parseSearchResponse({}), []);
  assert.deepEqual(parseSearchResponse({ results: 'oops' }), []);
  // An entry without a name is skipped, the rest still parse.
  assert.equal(parseSearchResponse({ results: [{}, { hash_name: 'X' }] }).length, 1);
});

test('priceoverview takes the median, not the minimum', () => {
  // The minimum jumps around with dumped listings; the median is steadier.
  const price = parsePriceOverview({
    success: true,
    lowest_price: '3225,06 руб.',
    median_price: '3370,98 руб.',
  });
  assert.equal(price, 337_098);
});

test('priceoverview falls back to the minimum when there is no median', () => {
  assert.equal(parsePriceOverview({ success: true, lowest_price: '$1.00' }), 100);
});

test('an unsuccessful priceoverview returns null', () => {
  assert.equal(parsePriceOverview({ success: false }), null);
  assert.equal(parsePriceOverview(null), null);
  assert.equal(parsePriceOverview({ success: true }), null);
});

test('an item name turns into a search query', () => {
  // Steam search returns zero results for a full market_hash_name: it cannot
  // digest the "|" character or the exterior parentheses.
  assert.equal(toSearchQuery('AK-47 | Redline (Field-Tested)'), 'AK-47 Redline');
  assert.equal(toSearchQuery('P250 | Sand Dune (Field-Tested)'), 'P250 Sand Dune');
});

test('the star and quality prefixes are dropped from the query', () => {
  assert.equal(
    toSearchQuery('★ StatTrak™ Karambit | Marble Fade (Factory New)'),
    'Karambit Marble Fade',
  );
  assert.equal(toSearchQuery('★ Sport Gloves | Vice (Field-Tested)'), 'Sport Gloves Vice');
  assert.equal(
    toSearchQuery('Souvenir AWP | Dragon Lore (Field-Tested)'),
    'AWP Dragon Lore',
  );
});

test('a name without markup stays as it is', () => {
  assert.equal(toSearchQuery('Operation Bravo Case'), 'Operation Bravo Case');
});
