import { ErrorCode } from './errors.ts';
import { ItemRarity } from './types.ts';

/**
 * Interface translations.
 *
 * The dictionary lives in the shared package rather than in the web app so
 * that the same keys are available to anything that renders user-facing text
 * — today the site, tomorrow an e-mail or a Telegram bot. Keys are flat and
 * dotted; nesting buys nothing and makes lookups awkward.
 */

export const LOCALES = ['ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** Falls back to Russian: the project ships to a Russian-speaking audience. */
export const DEFAULT_LOCALE: Locale = 'ru';

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

const ru = {
  'nav.cases': 'Кейсы',
  'nav.upgrade': 'Апгрейд',
  'nav.contract': 'Контракт',
  'nav.bonus': 'Бонус',
  'nav.crm': 'CRM',
  'nav.profile': 'Профиль',
  'nav.signIn': 'Войти через Steam',
  'nav.signOut': 'Выйти',
  'nav.topUp': 'Пополнить',

  'common.loading': 'Загрузка...',
  'common.save': 'Сохранить',
  'common.saving': 'Сохраняем...',
  'common.clear': 'Очистить',
  'common.search': 'Поиск по названию',
  'common.remove': 'Убрать',
  'common.signInRequired': 'Войдите через Steam.',
  'common.notEnoughFunds': 'Недостаточно средств на балансе',
  'common.itemsCount': 'предметов',
  'common.balance': 'Баланс',
  'common.language': 'Язык',
  'common.currency': 'Валюта',

  'home.latestDrops': 'Последние дропы',
  'home.dropsEmpty': 'Пока тихо — здесь появятся редкие дропы в реальном времени.',
  'home.cases': 'Кейсы',
  'home.noCases': 'Кейсов нет. Запустите наполнение каталога.',

  'case.openHint': 'Нажмите «Открыть» — предметы попадут в инвентарь сайта.',
  'case.open': 'Открыть',
  'case.opening': 'Открываем...',
  'case.spinning': 'Крутим...',
  'case.contents': 'Содержимое и шансы',
  'case.verifyHint': 'проверить можно в профиле после смены серверного сида',
  'case.openFailed': 'Не удалось открыть кейс',
  'case.roll': 'ролл',

  'drops.spent': 'Потрачено',
  'drops.won': 'Выпало на',
  'drops.sell': 'Продать',
  'drops.sold': 'Продано',
  'drops.selling': 'Продаём...',
  'drops.sellAll': 'Продать всё за',
  'drops.keep': 'Оставить в инвентаре',
  'drops.sellFailed': 'Не удалось продать',

  'deposit.title': 'Пополнить баланс',
  'deposit.demoNotice':
    'Демо-режим: оплата не производится, сумма зачисляется сразу. Настоящее пополнение появится вместе с платёжным провайдером.',
  'deposit.customAmount': 'Своя сумма',
  'deposit.amountRange': 'Сумма должна быть от 1 до 100 000.',
  'deposit.submit': 'Пополнить на',
  'deposit.processing': 'Зачисляем...',
  'deposit.failed': 'Не удалось пополнить баланс',

  'profile.steamProfile': 'Профиль в Steam',
  'profile.tradeUrl': 'Трейд-ссылка Steam',
  'profile.tradeUrlHint':
    'Нужна для вывода предметов. Взять её можно в настройках приватности инвентаря Steam. Ссылка проверяется на принадлежность вашему аккаунту — чужая не подойдёт.',
  'profile.tradeUrlLinked': 'Трейд-ссылка привязана',
  'profile.tradeUrlSaved': 'Трейд-ссылка сохранена',
  'profile.tradeUrlFailed': 'Не удалось сохранить трейд-ссылку',
  'profile.inventory': 'Инвентарь',
  'profile.inventoryEmpty': 'Пусто — откройте кейс.',
  'profile.inWithdrawal': 'В выводе',
  'profile.fairness': 'Честность',
  'profile.serverSeedHash': 'Хэш серверного сида',
  'profile.clientSeed': 'Клиентский сид',
  'profile.nonce': 'Nonce',
  'profile.fairnessHint':
    'Серверный сид скрыт, пока активен — иначе исход открытия можно было бы вычислить заранее. Смена сида раскрывает старый, и все прошлые открытия становятся проверяемыми.',
  'profile.rotateSeed': 'Сменить серверный сид',
  'profile.seedRevealed': 'Старый серверный сид раскрыт',
  'profile.rotateFailed': 'Не удалось сменить сид',
  'profile.openings': 'История открытий',
  'profile.case': 'Кейс',
  'profile.item': 'Предмет',
  'profile.price': 'Цена',
  'profile.roll': 'Ролл',
  'profile.verification': 'Проверка',
  'profile.seedStillActive': 'сид ещё активен',
  'profile.verifying': 'проверяем...',
  'profile.verified': 'подтверждено',
  'profile.mismatch': 'НЕ СХОДИТСЯ',
  'profile.loadFailed': 'Ошибка загрузки',
  'profile.openProfile': 'Профиль',
  'profile.sell': 'Продать',

  'upgrade.title': 'Апгрейд',
  'upgrade.intro':
    'Шанс не назначается вручную: он равен отношению цен, умноженному на {rtp}% — та же маржа, что и в кейсах. Ставка списывается при любом исходе.',
  'upgrade.signInHint': 'Поставьте свой скин против более дорогого. Войдите, чтобы начать.',
  'upgrade.yourItem': 'Ваш предмет',
  'upgrade.target': 'Цель',
  'upgrade.pickStake': 'Выберите предмет из инвентаря',
  'upgrade.pickTarget': 'Выберите цель из списка',
  'upgrade.myItems': 'Мои предметы',
  'upgrade.upgradeTo': 'Апгрейд до',
  'upgrade.available': 'доступно',
  'upgrade.run': 'Апгрейд',
  'upgrade.spinning': 'Крутим...',
  'upgrade.chance': 'шанс',
  'upgrade.success': 'Успех',
  'upgrade.miss': 'Мимо',
  'upgrade.won': 'Выигран {item}',
  'upgrade.lost': 'Не повезло — ролл {roll} из {threshold} выигрышных',
  'upgrade.emptyInventory': 'Инвентарь пуст — откройте кейс, чтобы получить предмет для апгрейда.',
  'upgrade.pickStakeFirst': 'Сначала выберите свой предмет.',
  'upgrade.noTargets': 'Для этой ставки подходящих предметов не нашлось.',
  'upgrade.failed': 'Апгрейд не удался',
  'upgrade.loadTargetsFailed': 'Не удалось загрузить цели апгрейда',
  'upgrade.loadInventoryFailed': 'Не удалось загрузить инвентарь',

  'contract.title': 'Контракт',
  'contract.intro':
    'Сложите от {min} до {max} предметов — контракт вернёт ровно один. Таблица исходов не назначается вручную: веса подбираются так, чтобы матожидание было равно {rtp}% от вложенного — та же маржа, что в кейсах и апгрейде.',
  'contract.signInHint': 'Обменяйте несколько предметов на один. Войдите, чтобы начать.',
  'contract.myItems': 'Мои предметы',
  'contract.stake': 'В контракте',
  'contract.stakeEmpty': 'Добавьте от {min} до {max} предметов из инвентаря.',
  'contract.stakeValue': 'Сумма вложенного',
  'contract.rewardRange': 'Награда от {min} до {max}',
  'contract.outcomes': 'Возможные исходы',
  'contract.outcomesHint':
    'Шансы посчитаны от вашей ставки — это именно та таблица, по которой пройдёт ролл.',
  'contract.run': 'Заключить контракт',
  'contract.spinning': 'Крутим...',
  'contract.needMore': 'Добавьте ещё {count} шт.',
  'contract.tooMany': 'Максимум {max} предметов.',
  'contract.result': 'Получено {item} за {price}',
  'contract.profit': 'Прибыль {amount}',
  'contract.loss': 'Убыток {amount}',
  'contract.emptyInventory': 'Инвентарь пуст — откройте кейс, чтобы собрать контракт.',
  'contract.failed': 'Не удалось заключить контракт',
  'contract.loadInventoryFailed': 'Не удалось загрузить инвентарь',
  'contract.clearStake': 'Очистить',
  'contract.history': 'История контрактов',
  'contract.roll': 'Ролл',

  'inventory.title': 'Инвентарь',
  'inventory.summaryValue': 'Стоимость',
  'inventory.filterAll': 'Все',
  'inventory.filterAvailable': 'Доступные',
  'inventory.filterPending': 'В выводе',
  'inventory.filterHistory': 'История',
  'inventory.bandAll': 'Любая цена',
  'inventory.bandUnder': 'до {max}',
  'inventory.bandBetween': '{min} – {max}',
  'inventory.bandOver': 'от {min}',
  'inventory.empty': 'Здесь пусто — откройте кейс.',
  'inventory.emptyFiltered': 'Под этот фильтр ничего не подошло.',
  'inventory.sell': 'Продать',
  'inventory.withdraw': 'Вывести',
  'inventory.withdrawStub': 'Заглушка: предмет помечается выведенным, трейд-оффер не отправляется.',
  'inventory.withdrawn': 'Выведено предметов: {count}',
  'inventory.withdrawFailed': 'Не удалось вывести предмет',
  'inventory.sellAll': 'Продать всё',
  'inventory.sellAllTitle': 'Продать всё?',
  'inventory.sellAllBody': 'Будет продано {count} шт. на сумму {total}. Отменить это нельзя.',
  'inventory.sellAllConfirm': 'Продать за {total}',
  'inventory.sellAllDone': 'Продано {count} шт. на {total}',
  'inventory.sellAllFailed': 'Не удалось продать предметы',
  'inventory.sellAllNothing': 'Продавать нечего',
  'inventory.cancel': 'Отмена',
  'inventory.acquired': 'Получен',
  'inventory.settled': 'Изменён',

  'status.AVAILABLE': 'В наличии',
  'status.LOCKED': 'В выводе',
  'status.WITHDRAWN': 'Выведен',
  'status.SOLD': 'Продан',
  'status.UPGRADED': 'В апгрейде',
  'status.CONTRACTED': 'В контракте',

  'home.heroTitle': 'Открывай кейсы CS2 честно',
  'home.heroSubtitle':
    'Каждый ролл считается из пары сидов и проверяется вручную. Никаких скрытых шансов.',
  'home.heroCta': 'Выбрать кейс',
  'home.heroSecondary': 'Как это работает',
  'home.statCases': 'Кейсов',
  'home.statItems': 'Предметов',
  'home.statRtp': 'Средний RTP',

  'footer.demo': 'Демо-сборка. Это не настоящая площадка: пополнение и вывод предметов заглушены.',
  'footer.fairness': 'Все роллы проверяемы',

  'bonus.title': 'Ежедневный бонус',
  'bonus.intro':
    'Раз в сутки — одно вращение. Колесо крутится тем же роллом, что и открытие кейса: по той же паре сидов и общему счётчику nonce, поэтому спин проверяется ровно так же, как дроп.',
  'bonus.signInHint': 'Крутите колесо раз в день. Войдите, чтобы начать.',
  'bonus.spin': 'Крутить',
  'bonus.spinning': 'Крутим...',
  'bonus.ready': 'Вращение доступно',
  'bonus.nextIn': 'Следующее вращение через {time}',
  'bonus.wonBalance': 'Выпало {amount} на баланс',
  'bonus.wonDiscount': 'Выпала скидка {percent}% на следующее открытие',
  'bonus.wonFreeCase': 'Выпало бесплатное открытие кейса до {max}',
  'bonus.wonItem': 'Выпал {item} за {price}',
  'bonus.failed': 'Не удалось прокрутить колесо',
  'bonus.prizeBalance': '{amount}',
  'bonus.prizeDiscount': 'Скидка {percent}%',
  'bonus.prizeFreeCase': 'Кейс до {max}',
  'bonus.prizeFreeItem': 'Скин до {max}',
  'bonus.vouchers': 'Ваши награды',
  'bonus.vouchersHint': 'Применяются автоматически при открытии кейса — берётся самая выгодная.',
  'bonus.vouchersEmpty': 'Неиспользованных наград нет.',
  'bonus.chanceLabel': 'шанс',
  'bonus.applied': 'Применён бонус: {prize}, минус {saving}',
  'bonus.willApply': 'К этому открытию применится бонус: {prize}',

  'bonusTeaser.ready': 'Ежедневный бонус готов',
  'bonusTeaser.readyHint': 'Крутите колесо — деньги, скидка, бесплатный кейс или скин.',
  'bonusTeaser.spin': 'Крутить',
  'bonusTeaser.waiting': 'Следующий бонус через {time}',
  'bonusTeaser.waitingHint': 'Загляните позже — вращение восстановится само.',
  'bonusTeaser.open': 'Открыть',

  'promo.label': 'Промокод',
  'promo.placeholder': 'Введите промокод',
  'promo.apply': 'Применить',
  'promo.applied': 'Промокод {code}: +{bonus}',
  'promo.invalid': 'Промокод не применён',
  'promo.total': 'Итого на баланс: {total}',
  'promo.creditedWithBonus': 'Зачислено {amount} и бонус {bonus}',

  'auth.finishing': 'Завершаем вход через Steam...',
  'auth.noToken': 'Steam не вернул токен',

  'rarity.CONSUMER': 'Ширпотреб',
  'rarity.INDUSTRIAL': 'Промышленное',
  'rarity.MILSPEC': 'Армейское',
  'rarity.RESTRICTED': 'Запрещённое',
  'rarity.CLASSIFIED': 'Засекреченное',
  'rarity.COVERT': 'Тайное',
  'rarity.EXTRAORDINARY': 'Экстраординарное',

  'error.INSUFFICIENT_FUNDS': 'Недостаточно средств на балансе',
  'error.RATE_LIMITED': 'Слишком часто. Подождите пару секунд.',
  'error.CASE_UNAVAILABLE': 'Кейс недоступен',
  'error.CASE_EMPTY': 'Кейс пуст',
  'error.BATCH_SIZE_INVALID': 'Недопустимое количество кейсов',
  'error.ACCOUNT_BANNED': 'Аккаунт заблокирован',
  'error.NO_ACTIVE_SEED': 'Нет активного сида — переавторизуйтесь',
  'error.ITEM_UNAVAILABLE': 'Предмет недоступен',
  'error.ITEM_ALREADY_SOLD': 'Часть предметов уже была продана',
  'error.ITEMS_CHANGED': 'Предметы были изменены, повторите попытку',
  'error.TRADE_URL_INVALID': 'Некорректная трейд-ссылка Steam',
  'error.TRADE_URL_FOREIGN': 'Трейд-ссылка принадлежит другому аккаунту Steam',
  'error.TRADE_URL_MISSING': 'Сначала укажите трейд-ссылку Steam',
  'error.WITHDRAWAL_NOT_CANCELLABLE': 'Заявку уже нельзя отменить',
  'error.UPGRADE_REJECTED': 'Апгрейд невозможен',
  'error.UPGRADE_TARGET_MISSING': 'Целевой предмет не найден',
  'error.MAINTENANCE': 'Сайт на техобслуживании',
  'error.BONUS_ON_COOLDOWN': 'Бонус ещё не готов — приходите позже',
  'error.BONUS_DISABLED': 'Ежедневный бонус временно отключён',
  'error.PROMO_INVALID': 'Промокод недействителен',
  'error.CONTRACT_REJECTED': 'Контракт невозможен',
  'error.CONTRACT_SIZE_INVALID': 'Недопустимое количество предметов в контракте',
  'error.CONTRACT_POOL_EMPTY': 'Для такой ставки не нашлось подходящих наград',
  'error.DEPOSITS_DISABLED': 'Пополнение отключено',
  'error.VALIDATION_FAILED': 'Ошибка валидации',
  'error.STEAM_RATE_LIMITED': 'Steam временно ограничил запросы, повторите позже',
} as const;

export type TranslationKey = keyof typeof ru;

const en: Record<TranslationKey, string> = {
  'nav.cases': 'Cases',
  'nav.upgrade': 'Upgrade',
  'nav.contract': 'Contract',
  'nav.bonus': 'Bonus',
  'nav.crm': 'CRM',
  'nav.profile': 'Profile',
  'nav.signIn': 'Sign in through Steam',
  'nav.signOut': 'Sign out',
  'nav.topUp': 'Top up',

  'common.loading': 'Loading...',
  'common.save': 'Save',
  'common.saving': 'Saving...',
  'common.clear': 'Clear',
  'common.search': 'Search by name',
  'common.remove': 'Remove',
  'common.signInRequired': 'Sign in through Steam.',
  'common.notEnoughFunds': 'Not enough balance',
  'common.itemsCount': 'items',
  'common.balance': 'Balance',
  'common.language': 'Language',
  'common.currency': 'Currency',

  'home.latestDrops': 'Latest drops',
  'home.dropsEmpty': 'Quiet for now — rare drops will show up here live.',
  'home.cases': 'Cases',
  'home.noCases': 'No cases yet. Populate the catalogue first.',

  'case.openHint': 'Press “Open” — the items land in your site inventory.',
  'case.open': 'Open',
  'case.opening': 'Opening...',
  'case.spinning': 'Spinning...',
  'case.contents': 'Contents and odds',
  'case.verifyHint': 'verifiable in your profile once you rotate the server seed',
  'case.openFailed': 'Could not open the case',
  'case.roll': 'roll',

  'drops.spent': 'Spent',
  'drops.won': 'Won',
  'drops.sell': 'Sell',
  'drops.sold': 'Sold',
  'drops.selling': 'Selling...',
  'drops.sellAll': 'Sell everything for',
  'drops.keep': 'Keep in inventory',
  'drops.sellFailed': 'Could not sell',

  'deposit.title': 'Top up balance',
  'deposit.demoNotice':
    'Demo mode: no payment is taken, the amount is credited immediately. Real top-ups arrive together with a payment provider.',
  'deposit.customAmount': 'Custom amount',
  'deposit.amountRange': 'Amount must be between 1 and 100,000.',
  'deposit.submit': 'Top up',
  'deposit.processing': 'Crediting...',
  'deposit.failed': 'Could not top up the balance',

  'profile.steamProfile': 'Steam profile',
  'profile.tradeUrl': 'Steam trade URL',
  'profile.tradeUrlHint':
    'Required to withdraw items. Find it in your Steam inventory privacy settings. The link is checked against your account — someone else’s will not work.',
  'profile.tradeUrlLinked': 'Trade URL linked',
  'profile.tradeUrlSaved': 'Trade URL saved',
  'profile.tradeUrlFailed': 'Could not save the trade URL',
  'profile.inventory': 'Inventory',
  'profile.inventoryEmpty': 'Empty — open a case.',
  'profile.inWithdrawal': 'Withdrawing',
  'profile.fairness': 'Fairness',
  'profile.serverSeedHash': 'Server seed hash',
  'profile.clientSeed': 'Client seed',
  'profile.nonce': 'Nonce',
  'profile.fairnessHint':
    'The server seed stays hidden while active — otherwise the outcome of an opening could be computed in advance. Rotating it reveals the old seed and makes every past opening verifiable.',
  'profile.rotateSeed': 'Rotate server seed',
  'profile.seedRevealed': 'Previous server seed revealed',
  'profile.rotateFailed': 'Could not rotate the seed',
  'profile.openings': 'Opening history',
  'profile.case': 'Case',
  'profile.item': 'Item',
  'profile.price': 'Price',
  'profile.roll': 'Roll',
  'profile.verification': 'Verification',
  'profile.seedStillActive': 'seed still active',
  'profile.verifying': 'verifying...',
  'profile.verified': 'verified',
  'profile.mismatch': 'MISMATCH',
  'profile.loadFailed': 'Failed to load',
  'profile.openProfile': 'Profile',
  'profile.sell': 'Sell',

  'upgrade.title': 'Upgrade',
  'upgrade.intro':
    'The chance is not set by hand: it equals the price ratio times {rtp}% — the same margin the cases run on. The stake is consumed either way.',
  'upgrade.signInHint': 'Stake your skin against a pricier one. Sign in to start.',
  'upgrade.yourItem': 'Your item',
  'upgrade.target': 'Target',
  'upgrade.pickStake': 'Pick an item from your inventory',
  'upgrade.pickTarget': 'Pick a target from the list',
  'upgrade.myItems': 'My items',
  'upgrade.upgradeTo': 'Upgrade to',
  'upgrade.available': 'available',
  'upgrade.run': 'Upgrade',
  'upgrade.spinning': 'Spinning...',
  'upgrade.chance': 'chance',
  'upgrade.success': 'Success',
  'upgrade.miss': 'Missed',
  'upgrade.won': 'Won {item}',
  'upgrade.lost': 'No luck — roll {roll} out of {threshold} winning tickets',
  'upgrade.emptyInventory': 'Inventory is empty — open a case to get something to stake.',
  'upgrade.pickStakeFirst': 'Pick your item first.',
  'upgrade.noTargets': 'No suitable targets for this stake.',
  'upgrade.failed': 'Upgrade failed',
  'upgrade.loadTargetsFailed': 'Could not load upgrade targets',
  'upgrade.loadInventoryFailed': 'Could not load the inventory',

  'contract.title': 'Contract',
  'contract.intro':
    'Put in between {min} and {max} items — a contract returns exactly one. The outcome table is not authored by hand: the weights are solved so the expected value is {rtp}% of what you staked, the same margin the cases and the upgrade run on.',
  'contract.signInHint': 'Trade several items for one. Sign in to start.',
  'contract.myItems': 'My items',
  'contract.stake': 'In the contract',
  'contract.stakeEmpty': 'Add between {min} and {max} items from your inventory.',
  'contract.stakeValue': 'Staked value',
  'contract.rewardRange': 'Reward between {min} and {max}',
  'contract.outcomes': 'Possible outcomes',
  'contract.outcomesHint':
    'The odds are computed from your stake — this is the very table the roll runs against.',
  'contract.run': 'Sign the contract',
  'contract.spinning': 'Spinning...',
  'contract.needMore': 'Add {count} more.',
  'contract.tooMany': 'At most {max} items.',
  'contract.result': 'Received {item} worth {price}',
  'contract.profit': 'Profit {amount}',
  'contract.loss': 'Loss {amount}',
  'contract.emptyInventory': 'Inventory is empty — open a case to assemble a contract.',
  'contract.failed': 'Could not sign the contract',
  'contract.loadInventoryFailed': 'Could not load the inventory',
  'contract.clearStake': 'Clear',
  'contract.history': 'Contract history',
  'contract.roll': 'Roll',

  'inventory.title': 'Inventory',
  'inventory.summaryValue': 'Value',
  'inventory.filterAll': 'All',
  'inventory.filterAvailable': 'Available',
  'inventory.filterPending': 'Withdrawing',
  'inventory.filterHistory': 'History',
  'inventory.bandAll': 'Any price',
  'inventory.bandUnder': 'under {max}',
  'inventory.bandBetween': '{min} – {max}',
  'inventory.bandOver': '{min} and up',
  'inventory.empty': 'Nothing here yet — open a case.',
  'inventory.emptyFiltered': 'Nothing matches this filter.',
  'inventory.sell': 'Sell',
  'inventory.withdraw': 'Withdraw',
  'inventory.withdrawStub': 'Placeholder: the item is marked withdrawn, no trade offer is sent.',
  'inventory.withdrawn': 'Withdrawn {count} item(s)',
  'inventory.withdrawFailed': 'Could not withdraw the item',
  'inventory.sellAll': 'Sell everything',
  'inventory.sellAllTitle': 'Sell everything?',
  'inventory.sellAllBody': '{count} item(s) will be sold for {total}. This cannot be undone.',
  'inventory.sellAllConfirm': 'Sell for {total}',
  'inventory.sellAllDone': 'Sold {count} item(s) for {total}',
  'inventory.sellAllFailed': 'Could not sell the items',
  'inventory.sellAllNothing': 'There is nothing to sell',
  'inventory.cancel': 'Cancel',
  'inventory.acquired': 'Acquired',
  'inventory.settled': 'Updated',

  'status.AVAILABLE': 'Available',
  'status.LOCKED': 'Withdrawing',
  'status.WITHDRAWN': 'Withdrawn',
  'status.SOLD': 'Sold',
  'status.UPGRADED': 'Upgraded',
  'status.CONTRACTED': 'Contracted',

  'home.heroTitle': 'Open CS2 cases, provably fair',
  'home.heroSubtitle':
    'Every roll is derived from a seed pair and can be checked by hand. No hidden odds.',
  'home.heroCta': 'Browse cases',
  'home.heroSecondary': 'How it works',
  'home.statCases': 'Cases',
  'home.statItems': 'Items',
  'home.statRtp': 'Average RTP',

  'footer.demo': 'Demo build. Not a real marketplace: top-ups and item withdrawals are stubbed.',
  'footer.fairness': 'Every roll is verifiable',

  'bonus.title': 'Daily bonus',
  'bonus.intro':
    'One spin a day. The wheel is rolled the way a case is opened — the same seed pair and the same shared nonce counter — so a spin is checked exactly like a drop.',
  'bonus.signInHint': 'Spin the wheel once a day. Sign in to start.',
  'bonus.spin': 'Spin',
  'bonus.spinning': 'Spinning...',
  'bonus.ready': 'A spin is ready',
  'bonus.nextIn': 'Next spin in {time}',
  'bonus.wonBalance': 'Won {amount} to your balance',
  'bonus.wonDiscount': 'Won {percent}% off your next opening',
  'bonus.wonFreeCase': 'Won a free opening of any case up to {max}',
  'bonus.wonItem': 'Won {item} worth {price}',
  'bonus.failed': 'Could not spin the wheel',
  'bonus.prizeBalance': '{amount}',
  'bonus.prizeDiscount': '{percent}% off',
  'bonus.prizeFreeCase': 'Case up to {max}',
  'bonus.prizeFreeItem': 'Skin up to {max}',
  'bonus.vouchers': 'Your rewards',
  'bonus.vouchersHint': 'Applied automatically when you open a case — whichever is worth most.',
  'bonus.vouchersEmpty': 'No unspent rewards.',
  'bonus.chanceLabel': 'chance',
  'bonus.applied': 'Bonus applied: {prize}, {saving} off',
  'bonus.willApply': 'A bonus will be applied to this opening: {prize}',

  'bonusTeaser.ready': 'Your daily bonus is ready',
  'bonusTeaser.readyHint': 'Spin the wheel — money, a discount, a free case or a skin.',
  'bonusTeaser.spin': 'Spin',
  'bonusTeaser.waiting': 'Next bonus in {time}',
  'bonusTeaser.waitingHint': 'Come back later — the spin recharges on its own.',
  'bonusTeaser.open': 'Open',

  'promo.label': 'Promo code',
  'promo.placeholder': 'Enter a promo code',
  'promo.apply': 'Apply',
  'promo.applied': 'Promo {code}: +{bonus}',
  'promo.invalid': 'Promo code not applied',
  'promo.total': 'Total credited: {total}',
  'promo.creditedWithBonus': 'Credited {amount} plus a {bonus} bonus',

  'auth.finishing': 'Finishing Steam sign-in...',
  'auth.noToken': 'Steam returned no token',

  'rarity.CONSUMER': 'Consumer Grade',
  'rarity.INDUSTRIAL': 'Industrial Grade',
  'rarity.MILSPEC': 'Mil-Spec',
  'rarity.RESTRICTED': 'Restricted',
  'rarity.CLASSIFIED': 'Classified',
  'rarity.COVERT': 'Covert',
  'rarity.EXTRAORDINARY': 'Extraordinary',

  'error.INSUFFICIENT_FUNDS': 'Not enough balance',
  'error.RATE_LIMITED': 'Too fast. Wait a couple of seconds.',
  'error.CASE_UNAVAILABLE': 'Case unavailable',
  'error.CASE_EMPTY': 'Case is empty',
  'error.BATCH_SIZE_INVALID': 'Invalid number of cases',
  'error.ACCOUNT_BANNED': 'Account is banned',
  'error.NO_ACTIVE_SEED': 'No active seed — sign in again',
  'error.ITEM_UNAVAILABLE': 'Item unavailable',
  'error.ITEM_ALREADY_SOLD': 'Some items have already been sold',
  'error.ITEMS_CHANGED': 'Items changed, please try again',
  'error.TRADE_URL_INVALID': 'Invalid Steam trade URL',
  'error.TRADE_URL_FOREIGN': 'That trade URL belongs to a different Steam account',
  'error.TRADE_URL_MISSING': 'Set your Steam trade URL first',
  'error.WITHDRAWAL_NOT_CANCELLABLE': 'This request can no longer be cancelled',
  'error.UPGRADE_REJECTED': 'Upgrade not possible',
  'error.UPGRADE_TARGET_MISSING': 'Target item not found',
  'error.MAINTENANCE': 'The site is under maintenance',
  'error.BONUS_ON_COOLDOWN': 'The bonus is not ready yet — come back later',
  'error.BONUS_DISABLED': 'The daily bonus is switched off for now',
  'error.PROMO_INVALID': 'That promo code is not valid',
  'error.CONTRACT_REJECTED': 'Contract not possible',
  'error.CONTRACT_SIZE_INVALID': 'Invalid number of items in the contract',
  'error.CONTRACT_POOL_EMPTY': 'No suitable rewards for a stake of this size',
  'error.DEPOSITS_DISABLED': 'Top-ups are disabled',
  'error.VALIDATION_FAILED': 'Validation failed',
  'error.STEAM_RATE_LIMITED': 'Steam is rate-limiting requests, try again later',
};

const DICTIONARIES: Record<Locale, Record<TranslationKey, string>> = { ru, en };

/**
 * Looks up a key and substitutes `{placeholders}`.
 *
 * A missing key returns the key itself rather than an empty string: a visible
 * `upgrade.title` in the layout is a bug report, whereas a blank line looks
 * like an intentionally empty element and survives review.
 */
export function translate(
  locale: Locale,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const template = DICTIONARIES[locale]?.[key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Picks the display name for a locale.
 *
 * Content lives in the database, not in the dictionary, so translation here is
 * a per-row fallback rather than a key lookup: an untranslated case shows its
 * base name, which reads worse than a translation but far better than a blank.
 */
export function localizedName(
  locale: Locale,
  entity: { name: string; nameEn?: string | null },
): string {
  if (locale === 'en') return entity.nameEn?.trim() || entity.name;
  return entity.name;
}

/** Localized rarity label. */
export function rarityLabel(locale: Locale, rarity: ItemRarity): string {
  return translate(locale, `rarity.${rarity}` as TranslationKey);
}

/**
 * Turns an API error into readable text.
 *
 * Prefers the translated code; falls back to whatever the server said so an
 * error added on the backend is still legible before its translation lands.
 */
export function translateError(locale: Locale, code: string | undefined, fallback: string): string {
  if (!code) return fallback;
  const key = `error.${code}` as TranslationKey;
  const translated = DICTIONARIES[locale]?.[key];
  return translated ?? fallback;
}

export { ErrorCode };
