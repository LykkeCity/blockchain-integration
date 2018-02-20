const RippleAPI = require('ripple-lib').RippleAPI,
	Wallet = require('../core/wallet.js'),
	utils = require('../core/utils.js'),
	codec = require('ripple-address-codec'),
	Big = require('big.js'),
	crypto = require('crypto'),
	SEPARATOR = '+',
	PRECISION = 1e6,
	// PRECISION_ASSET = 1e16,
	DECIMALS = 6,
	// DECIMALS_ASSET = 12,
	RESERVE = 20;

class XRPWallet extends Wallet {
	constructor(testnet, node, logger, onTx, refreshEach, pending, page) {
		super(testnet, node, logger, onTx, refreshEach);
		
		// hash of transactions being watched (statuses are updated on each refresh, callback is called each status update)
		this.pending = {};
		(pending || []).forEach(tx => {
			this.pending[tx.hash] = tx.status;
		});

		// last known (from transactions in db) validated ledger version
		this.height = parseInt(page || 0);
	}

	/**
	 * Initializes view wallet: connects to node, syncs unknown payments & balances.
	 * All the sequence is retried 3 times in a row in case of error.
	 *
	 * @throws {Wallet.Error} [in promise] if cannot connect after 10 attempts each 3 seconds
	 * @throws {Wallet.Error} [in promise] if retry failed after 3 attempts
	 * @throws {Wallet.Error} [in promise] if failed to get balance
	 * @return {Promise} resolves to cuurent balance (String) or error if something is wrong
	 */
	initViewWallet(address) {
		this.api = new RippleAPI({server: this.node});
		this.account = address;

		return this.backoff(async () => {
			this.log.info(`Loading view wallet for address ${address}`);

			await this.api.connect();
			
			await this.backoff(async () => {
				let info = await this.api.getAccountInfo(this.account);
				this.log.debug(`Initial account info ${JSON.stringify(info)}`);
				this.balance = {
					native: parseInt(Big(info.xrpBalance).times(PRECISION).toFixed(0))
				};
				if (!this.height) {
					this.height = info.previousAffectingTransactionLedgerVersion - 10;
				} else {
					this.height = await this.api.getLedgerVersion() - 100;
				}
			}, attempt => attempt >= 3 ? -1 : Math.pow(3, attempt + 1));
			// try {
			// } catch (e) {
			// 	if (e.message === 'actNotFound') {
			// 		this.log.warn(`Account not found when getting account info, ignoring`);
			// 		this.balance = {native: 0};
			// 	} else {
			// 		this.log.warn(`Error when getting account info: ${e.message}`);
			// 	}
			// }

			this.status = Wallet.Status.Ready;

			this.log.info(`Done loading view wallet for account ${address}`);

			this.refreshTimeout = setTimeout(this.refresh.bind(this), this.refreshEach);

			return this.balance;
		}, attempt => attempt >= 3 ? -1 : Math.pow(2, attempt + 1));
	}

	async refresh () {
		if (!this.api) {
			throw new Wallet.Error(Wallet.Errors.EXCEPTION, 'No connection');
		} 
		if (this.refreshing) {
			return;
		}
		this.refreshing = true;
		try {
			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = 0;

			let opts = {earliestFirst: true};
			if (this.height) {
				opts.minLedgerVersion = this.height;
			}

			this.log.info(`Refreshing      (${JSON.stringify(opts)})...`);
			let payments = await this.api.getTransactions(this.account, opts);

			if (payments && payments.length) {
				this.log.debug(`Processing ${payments.length} payments`);
				payments.forEach(this._onTx.bind(this));
				let heights = payments.map(p => p.outcome && p.outcome.ledgerVersion).filter(v => !!v);
				if (heights) {
					this.height = Math.max(...heights);
				}
			}
			// this.height = await this.api.getLedgerVersion();

			await this.balances();

		} catch (e) {
			this.log.error(e, 'Error in refresh');
		} finally {
			this.refreshTimeout = setTimeout(this.refresh.bind(this), this.refreshEach);
			this.refreshing = false;
			this.log.info(`Refreshing done (${this.height}), ${Object.keys(this.pending).length} pending tx.`);
			Object.keys(this.pending).forEach(hash => {
				this._onTx(hash);
			});
		}
	}

	/**
	 * Open offline wallet from seed. Parses seed and stores keypair in a property, must be cleared after use.
	 *
	 * @throws {Wallet.Error} If seed is invalid
	 * @param  {String} seed Monero spend key
	 * @return {Promise} which resolves to undefined if succeeded and error if not
	 */
	initSignWallet (address, seed) {
		try {
			this.log.info(`Loading sign wallet for address ${address}`);
			this.api = new RippleAPI();
			this.account = address;
			this.secret = seed;
			this.status = Wallet.Status.Ready;
			return Promise.resolve();
		} catch (e) {
			this.log.error(e, 'Error in sign wallet initialization');
			return Promise.reject(new Wallet.Error(Wallet.Errors.EXCEPTION, e.message || e.code || 'Cannot init sign wallet'));
		}
	}

	async close () {
		try {
			let i = 1000;
			while (this.refreshing && i--) {
				await utils.wait(100);
			}

			clearTimeout(this.refreshTimeout);
			this.refreshTimeout = 0;

			this.account = this.secret = undefined;
			if (this.api) {
				let promise = this.api.disconnect();
				this.api = null;
				return promise;
			}
			return utils.wait(2000);
		} catch (e) {
			this.log.error(e, 'Error in wallet close');
			throw new Wallet.Error(Wallet.Errors.EXCEPTION, e.message || e.code || 'Cannot close wallet');
		} finally {
			this.status = Wallet.Status.Initial;
		}
	}

	async balances () {
		if (!this.api) {
			throw new Wallet.Error(Wallet.Errors.EXCEPTION, 'No node in conig');
		}
		let bal = await this.api.getBalances(this.account, {currency: 'XRP'});
		this.balance = {
			native: bal && bal.length ? parseInt(Big(bal[0].value).times(PRECISION).toFixed(0)) : 0
		};
		this.log.info(`Balance of ${this.account} is ${JSON.stringify(this.balance)}`);
		return this.balance;
	}

	async currentBalance () {
		return (await this.balances()).native;
	}

	address() {
		return this.account;
	}

	addressDecode(str) {
		if (str) {
			let [address, memo] = str.split(SEPARATOR);
			if (address) {
				try {
					if (codec.isValidAddress(address) && (!memo || (('' + parseInt(memo)) === ('' + memo)))) {
						return {
							address: address,
							paymentId: memo
						};
					} else {
						return undefined;
					}
				} catch (e) {
					return undefined;
				}
			}
		}
	}

	addressEncode(address, paymentId) {
		if (paymentId) {
			return address + SEPARATOR + paymentId;
		}
		return address;
	}

	addressCreate (paymentId) {
		return this.addressEncode(this.account, paymentId || crypto.randomBytes(4).readUInt32BE(0, true));
	}

	async createUnsignedTransaction (tx) {
		if (!(tx instanceof Wallet.Tx)) {
			return {error: new Wallet.Error(Wallet.Errors.VALIDATION, 'createUnsignedTransaction argument must be Tx instance')};
		}

		if (tx.operations.length !== 1) {
			return {error: new Wallet.Error(Wallet.Errors.VALIDATION, 'Ripple supports only 1-to-1 transactions')};
		}

		if (!this.api) {
			return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, 'no connection')};
		}

		try {
			await this.balances();

			let height = await this.api.getLedgerVersion();

			this.log.debug(`Creating tx ${tx._id} in ${this.account} at ${height}: ${JSON.stringify(tx.toJSON())}`);

			// check we have enough funds
			let total = Big(tx.operations.map(o => o.amount).reduce((a, b) => a + b)).div(PRECISION),
				current = Big((await this.balances()).native).div(PRECISION);

			if (tx.operations.filter(o => o.amount <= 0).length) {
				return {error: new Wallet.Error(Wallet.Errors.NOT_ENOUGH_AMOUNT, 'Operation amount must be greater than 0')};
			}

			if (tx.operations.filter(o => o.asset !== 'XRP').length) {
				return {error: new Wallet.Error(Wallet.Errors.VALIDATION, 'Only \'XRP\' asset supported by Ripple wallet')};
			}

			if (current.cmp(total.plus(RESERVE)) === -1) {
				this.log.error(`Not enough funds: have ${current.toString()} while requested to transfer ${total.toString()}, yet need a reserve of ${RESERVE}`);
				return {error: new Wallet.Error(Wallet.Errors.NOT_ENOUGH_FUNDS)};
			}

			let op = tx.operations[0],
				spec = {
					source: {
						address: op.from,
						maxAmount: {
							value: Big(op.amount).div(PRECISION).toFixed(DECIMALS),
							currency: op.asset
						},
					},

					destination: {
						address: op.to,
						amount: {
							value: Big(op.amount).div(PRECISION).toFixed(DECIMALS),
							currency: op.asset
						},
					},
				};

			if (op.sourcePaymentId) {
				spec.source.tag = parseInt(op.sourcePaymentId);
			}

			if (op.paymentId) {
				spec.destination.tag = parseInt(op.paymentId);
			}

			this.log.debug(`Spec for tx ${tx._id}: ${JSON.stringify(spec)}`);

			let data = await this.api.preparePayment(this.account, spec, {maxLedgerVersion: height + 4});
			
			this.log.debug(`preparePayment for ${tx._id}: ${JSON.stringify(data)}`);

			return {unsigned: new Buffer(data.txJSON).toString('base64')};
		} catch (e) {
			this.log.error(e, 'Error when creating transaction');
			return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, e.message || e.code || 'Cannot create transaction')};
		}
	}

	signTransaction (data) {
		if (typeof data !== 'string') {
			return {error: new Wallet.Error(Wallet.Errors.VALIDATION, 'signTransaction argument must be a string')};
		}

		if (!this.api) {
			return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, 'no offline api')};
		}

		try {
			this.log.debug(`signing tx in ${this.account}`);

			data = Buffer.from(data, 'base64').toString();

			let signed = this.api.sign(data, this.secret);

			this.log.debug(`tx signed in ${this.account}`);
			return {signed: signed.id + SEPARATOR + signed.signedTransaction};
		} catch (e) {
			this.log.error(e, 'Error in sign tx');
			return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, e.message || e.code || 'Cannot sign transaction')};
		}

	}

	async submitSignedTransaction (data) {
		if (typeof data !== 'string') {
			return {error: new Wallet.Error(Wallet.Errors.VALIDATION, 'submitSignedTransaction argument must be a string')};
		}

		if (!this.api) {
			return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, 'no connection')};
		}

		try {
			this.log.debug(`submitting tx in ${this.account}`);

			let [id, signedTransaction] = data.split(SEPARATOR);
			if (!id || !signedTransaction) {
				return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, 'invalid format of signed transaction data')};
			}

			let result = await this.api.submit(signedTransaction);

			this.log.debug(`tx submission returned ${JSON.stringify(result)}`);

			if (result.resultCode === 'tesSUCCESS') {
				// this.log.debug(`tx right after submission ${JSON.stringify(await this.api.getTransaction(id))}`);
				return {hash: id};
			// } else if (result.resultCode.indexOf('tel') === 0 || result.resultCode.indexOf('tem') === 0) {
			} else if (result.resultCode === 'tecNO_DST') {
				return {error: new Wallet.Error(Wallet.Errors.NOT_ENOUGH_AMOUNT)};
			} else if (result.resultCode === 'tec_UNFUNDED') {
				return {error: new Wallet.Error(Wallet.Errors.NOT_ENOUGH_FUNDS)};
			} else if (result.resultCode === 'tefPAST_SEQ') {
				return {error: new Wallet.Error(Wallet.Errors.NOT_ENOUGH_FUNDS)};
			} else {
				return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, result.resultCode)};
			}
		} catch (e) {
			this.log.error(e, 'Error when submitting tx');
			if (e.name === 'BadResponseError' && e.data && e.data.extras && e.data.extras.result_codes) {
				if (e.data.extras.result_codes.indexOf('op_underfunded') !== -1) {
					return {error: new Wallet.Error(Wallet.Errors.NOT_ENOUGH_FUNDS)};
				}
				if (e.data.extras.result_codes.indexOf('op_low_reserve') !== -1) {
					return {error: new Wallet.Error(Wallet.Errors.NOT_ENOUGH_AMOUNT)};
				}
			}
			return {error: new Wallet.Error(Wallet.Errors.EXCEPTION, e.message || e.code || 'Cannot submit transaction')};
		}
	}

	async transactions (txid, incoming, outgoing) {
		try {
			return this.xmr.transactions(txid, incoming, outgoing);
		} catch (e) {
			this.log.error(e, 'Error in tx listing');
			throw new Wallet.Error(Wallet.Errors.EXCEPTION, e.message);
		}
	}

	/**
	 * Just create random wallet
	 * @return object with wallet data, should never fail
	 */
	createPaperWallet () {
		let keypair = this.api.generateAddress(),
			ret = {
				address: keypair.address,
				seed: keypair.secret
			};

		return ret;
	}

	/**
	 * Initializes view wallet in offline mode. Doesn't connect to node. 
	 *
	 * @throws {Wallet.Error}	if failed to open wallet
	 * @return {undefined}	in case of success
	 */
	initViewWalletOffline (address) {
		this.api = new RippleAPI();
		this.account = address;
		this.status = Wallet.Status.Ready;
	}

	async _onTx (info) {
		if (!this.api) {
			return;
		}

		// catch everything since it's a callback
		try {
			this.log.debug(`_onTx ${JSON.stringify(info)}`);

			if (typeof info === 'string') {
				info = await this.api.getTransaction(info);
				this.log.debug(`_onTx lookup returned ${JSON.stringify(info)}`);

				if (!info) {
					return;
				}
			}

			if (info.type !== 'payment') {
				return this.log.info(`${info.id} is a non-payment, doing nothing`);
			}

			let tx = new Wallet.Tx();
			tx.hash = info.id;
			tx.timestamp = info.outcome && info.outcome.timestamp && new Date(info.outcome.timestamp).getTime();

			if (info.outcome) {
				if (info.outcome.result === 'tesSUCCESS') {
					tx.status = Wallet.Tx.Status.Sent;
					if (info.outcome.ledgerVersion) {
						tx.status = Wallet.Tx.Status.Completed;
					}
				} else {
					this.log.info(`${info.id} status is ${info.outcome.result}, doing nothing`);
					tx.error = info.outcome.result;
					tx.status = Wallet.Tx.Status.Failed;
				}

				if (!info.outcome.deliveredAmount || !info.outcome.deliveredAmount.currency || info.outcome.deliveredAmount.currency !== 'XRP') {
					this.log.info(`${info.id} is not XRP, doing nothing`);
					if (!tx.error) {
						tx.error = 'no deliveredAmount';
					}
				}

				tx.block = tx.page = info.outcome.ledgerVersion;

				if (info.specification && info.specification.source && info.specification.destination && info.outcome.deliveredAmount) {
					let op = tx.addPayment(info.specification.source.address, 
						info.specification.destination.address, 
						info.outcome.deliveredAmount.currency, 
						parseInt(Big(info.outcome.deliveredAmount.value).times(PRECISION).toFixed(0)),
						info.specification.source.tag,
						info.specification.destination.tag);

					tx.incoming = op.from !== this.account;

					if (!tx.incoming) {
						op.fee = parseInt(Big(info.outcome.fee || '0').times(PRECISION).toFixed(0));
					}
				}

			} else {
				tx.error = 'no outcome';
			}

			this.log.debug(`${info.id} constructed tx ${JSON.stringify(tx)}`);
			this.onTx(tx);

		} catch (e) {
			this.log.error(e, 'during _onTx');
		}
	}
}

XRPWallet.Tx = Wallet.Tx;
XRPWallet.Status = Wallet.Status;
XRPWallet.Error = Wallet.Error;
XRPWallet.Errors = Wallet.Errors;
XRPWallet.Account = Wallet.Account;
XRPWallet.Tx = Wallet.Tx;


module.exports = XRPWallet;