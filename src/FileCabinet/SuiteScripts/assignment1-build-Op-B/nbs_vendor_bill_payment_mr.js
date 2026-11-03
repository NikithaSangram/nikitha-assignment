/**
 * Creates vendor bill payments in ascending remaining-balance order while
 * preserving the configured minimum balance in the designated bank account.
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/log', 'N/record', 'N/runtime', 'N/search'], (log, record, runtime, search) => {
    const PARAMS = {
        amountLimit: 'custscript_nbs_ap_amount_limit',
        departments: 'custscript_nbs_ap_departments',
        bankAccount: 'custscript_nbs_ap_bank_account',
        minimumBalance: 'custscript_nbs_ap_minimum_balance'
    };
    const EXECUTION_REFERENCE_FIELD = 'custbody_nbs_payment_execution_ref';
    const REDUCE_KEY = 'eligible_vendor_bills';

    /** Reads and validates the deployment parameters. */
    const getConfiguration = () => {
        const script = runtime.getCurrentScript();
        const amountLimit = Number(script.getParameter({ name: PARAMS.amountLimit }));
        const departments = parseMultiSelect(script.getParameter({ name: PARAMS.departments }));
        const bankAccountId = script.getParameter({ name: PARAMS.bankAccount });
        const minimumBalance = Number(script.getParameter({ name: PARAMS.minimumBalance }));
        if (!Number.isFinite(amountLimit) || amountLimit <= 0) {
            throw new Error('Maximum bill remaining amount must be greater than zero.');
        }
        if (departments.length === 0) {
            throw new Error('Select at least one department.');
        }
        if (!/^\d+$/.test(String(bankAccountId || ''))) {
            throw new Error('Select a designated bank account.');
        }
        if (!Number.isFinite(minimumBalance)) {
            throw new Error('Minimum bank-account balance must be zero or greater.');
        }

        return { amountLimit, departments, bankAccountId, minimumBalance };
    };

    /** Returns the open vendor bills eligible for payment. */
    const getInputData = () => {
        const config = getConfiguration();
        return search.create({
            type: search.Type.VENDOR_BILL,
            filters: [
                ['mainline', 'is', 'T'],
                'AND', ['status', 'anyof', 'VendBill:A'],
                'AND', ['amountremaining', 'greaterthan', '0'],
                'AND', ['amountremaining', 'lessthanorequalto', String(config.amountLimit)],
                'AND', ['department', 'anyof', config.departments]
            ],
            columns: [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'entity' }),
                search.createColumn({ name: 'department' }),
                search.createColumn({ name: 'amountremaining' })
            ]
        });
    };

    /** Collects eligible bills for one sequential reducer. */
    const map = context => {
        const result = JSON.parse(context.value);
        const values = result.values || {};
        const bill = {
            id: String(result.id || getSelectValue(values.internalid)),
            vendorId: String(getSelectValue(values.entity)),
            departmentId: String(getSelectValue(values.department)),
            remaining: parseAmount(values.amountremaining)
        };

        if (!bill.id || !bill.vendorId || !Number.isFinite(bill.remaining) || bill.remaining <= 0) {
            throw new Error(`Unable to read eligible vendor bill ${result.id || ''}.`);
        }
        context.write({ key: REDUCE_KEY, value: JSON.stringify(bill) });
    };

    /** Checks the bank balance and creates payments sequentially by amount. */
    const reduce = context => {
        const config = getConfiguration();
        const bills = context.values.map(value => JSON.parse(value));
        bills.sort((first, second) => first.remaining - second.remaining || compareIds(first.id, second.id));

        let bankBalance = getBankBalance(config.bankAccountId);
        let paymentsCreated = 0;
        const executionReference = createExecutionReference();

        for (const bill of bills) {
            const currentBill = getCurrentBill(bill.id);
            if (!currentBill || !config.departments.includes(String(currentBill.departmentId))) {
                log.audit({
                    title: 'Vendor bill skipped',
                    details: `Bill ${bill.id} is no longer open or is outside the selected departments.`
                });
                continue;
            }
            if (currentBill.remaining <= 0 || currentBill.remaining > config.amountLimit) {
                log.audit({
                    title: 'Vendor bill skipped',
                    details: `Bill ${bill.id} no longer meets the remaining-amount limit.`
                });
                continue;
            }

            if (bankBalance - currentBill.remaining < config.minimumBalance) {
                log.audit({
                    title: 'Minimum bank balance reached',
                    details: `Stopped before bill ${bill.id}. Balance ${bankBalance}; ` +
                        `payment ${currentBill.remaining}; minimum ${config.minimumBalance}.`
                });
                break;
            }

            try {
                createBillPayment({
                    billId: bill.id,
                    vendorId: currentBill.vendorId,
                    bankAccountId: config.bankAccountId,
                    amount: currentBill.remaining,
                    executionReference
                });

                bankBalance -= currentBill.remaining;
                paymentsCreated += 1;
                log.audit({
                    title: 'Vendor bill payment created',
                    details: `Bill ${bill.id}; amount ${currentBill.remaining}; ` +
                        `execution reference ${executionReference}.`
                });
            } catch (error) {
                log.error({
                    title: `Vendor bill payment failed: ${bill.id}`,
                    details: error.message || String(error)
                });
            }
        }

        log.audit({
            title: 'Vendor bill payment run complete',
            details: `Eligible bills ${bills.length}; payments created ${paymentsCreated}; ` +
                `execution reference ${executionReference}.`
        });
    };

    /** Logs framework-level map and reduce errors and summarizes the run. */
    const summarize = summary => {
        log.audit({
            title: 'Vendor bill payment Map/Reduce summary',
            details: `Usage ${summary.usage}; concurrency ${summary.concurrency}; seconds ${summary.seconds}.`
        });
        summary.mapSummary.errors.iterator().each((key, error) => {
            log.error({ title: `Map error: ${key}`, details: error });
            return true;
        });
        summary.reduceSummary.errors.iterator().each((key, error) => {
            log.error({ title: `Reduce error: ${key}`, details: error });
            return true;
        });
    };

    /** Re-reads a bill immediately before payment creation. */
    const getCurrentBill = billId => {
        try {
            const fields = search.lookupFields({
                type: search.Type.VENDOR_BILL,
                id: billId,
                columns: ['amountremaining', 'entity', 'department']
            });
            return {
                remaining: parseAmount(fields.amountremaining),
                vendorId: String(getSelectValue(fields.entity)),
                departmentId: String(getSelectValue(fields.department))
            };
        } catch (error) {
            return null;
        }
    };

    /** Reads the current book balance for the configured bank account. */
    const getBankBalance = bankAccountId => {
        const account = search.lookupFields({
            type: search.Type.ACCOUNT,
            id: bankAccountId,
            columns: ['balance']
        });
        const balance = parseAmount(account.balance);
        log.audit({
            title: 'Retrieved bank balance',
            details: `Bank account ${bankAccountId}; balance ${balance}.`
        });
        if (!Number.isFinite(balance)) {
            throw new Error(`Could not read the balance for bank account ${bankAccountId}.`);
        }
        return balance;
    };

    /** Creates and saves a payment applied only to the supplied vendor bill. */
    const createBillPayment = paymentData => {
        //const payment = record.create({ type: record.Type.VENDOR_PAYMENT, isDynamic: true, defaultValues: {
        //    entity: Number(paymentData.vendorId)
        //}});
    const payment = record.transform({
        fromType: record.Type.VENDOR_BILL,
        fromId: Number(paymentData.billId),
        toType: record.Type.VENDOR_PAYMENT,
        isDynamic: true
        });
        //payment.setValue({ fieldId: 'entity', value: Number(paymentData.vendorId) });
        payment.setValue({ fieldId: 'account', value: Number(paymentData.bankAccountId) });
        payment.setValue({ fieldId: EXECUTION_REFERENCE_FIELD, value: paymentData.executionReference });

        const applyCount = payment.getLineCount({ sublistId: 'apply' });
        let billApplied = false;
        for (let line = 0; line < applyCount; line += 1) {
            const appliedBillId = payment.getSublistValue({
                sublistId: 'apply',
                fieldId: 'doc',
                line
            });
            if (String(appliedBillId) !== String(paymentData.billId)) continue;

            payment.selectLine({ sublistId: 'apply', line });
            payment.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
            payment.setCurrentSublistValue({
                sublistId: 'apply',
                fieldId: 'amount',
                value: paymentData.amount
            });
            payment.commitLine({ sublistId: 'apply' });
            billApplied = true;
            break;
        }

        if (!billApplied) {
            throw new Error(`Vendor bill ${paymentData.billId} was not available on the payment apply sublist.`);
        }
        return payment.save({ enableSourcing: true, ignoreMandatoryFields: false });
    };

    /** Parses a multi-select script parameter. */
    const parseMultiSelect = value => {
        if (Array.isArray(value)) return value.map(String).filter(Boolean);
        return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    };

    /** Returns the value from a search select result or scalar. */
    const getSelectValue = value => {
        if (Array.isArray(value)) return value.length ? getSelectValue(value[0]) : '';
        if (value && typeof value === 'object' && 'value' in value) return value.value;
        return value || '';
    };

    /** Parses numeric search and lookup values. */
    const parseAmount = value => {
        const normalized = value && typeof value === 'object' && 'value' in value ? value.value : value;
        return Number.parseFloat(String(normalized ?? '').replace(/,/g, ''));
    };

    /** Sorts bill IDs numerically where possible, then lexically. */
    const compareIds = (first, second) => {
        const numericDifference = Number(first) - Number(second);
        return Number.isFinite(numericDifference) && numericDifference !== 0
            ? numericDifference
            : String(first).localeCompare(String(second));
    };

    /** Creates one human-readable reference shared by payments in this reduce run. */
    const createExecutionReference = () => {
        const script = runtime.getCurrentScript();
        return `NBS-AP-${script.deploymentId || script.id}-${new Date().toISOString()}`;
    };

    return { getInputData, map, reduce, summarize };
});