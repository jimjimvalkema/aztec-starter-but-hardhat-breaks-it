import { EasyPrivateVotingContractArtifact, EasyPrivateVotingContract } from "../src/artifacts/EasyPrivateVoting"
import { AccountManager, AccountWallet, CompleteAddress, ContractDeployer, createLogger, Fr, PXE, waitForPXE, TxStatus, createPXEClient, getContractInstanceFromDeployParams, Logger } from "@aztec/aztec.js";
import { getInitialTestAccountsWallets, generateSchnorrAccounts } from "@aztec/accounts/testing"
import { getSchnorrAccount } from '@aztec/accounts/schnorr';
import { spawn } from 'child_process';
import { SponsoredFeePaymentMethod } from "@aztec/aztec.js/fee/testing";
import { getFeeJuiceBalance, type L2AmountClaim, L1FeeJuicePortalManager, FeeJuicePaymentMethodWithClaim, AztecAddress } from "@aztec/aztec.js";
import { createEthereumChain, createL1Clients } from '@aztec/ethereum';
import { getDeployedSponsoredFPCAddress } from "../src/utils/sponsored_fpc";

import { expect } from "chai";

const setupSandbox = async () => {
    const { PXE_URL = 'http://localhost:8080' } = process.env;
    const pxe = createPXEClient(PXE_URL);
    await waitForPXE(pxe);
    return pxe;
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));


async function setup() {
    const skipSandbox = process.env.SKIP_SANDBOX === 'true';
    let sandboxInstance;
    if (!skipSandbox) {
        sandboxInstance = spawn("aztec", ["start", "--sandbox"], {
            detached: true,
            stdio: 'ignore'
        })
        await sleep(15000);
    }

    const logger = createLogger('aztec:aztec-starter:accounts');
    logger.info("Aztec-Starter tests running.")

    const pxe = await setupSandbox();

    const wallets = await getInitialTestAccountsWallets(pxe);
    const accounts = wallets.map(w => w.getCompleteAddress());
    const deployedSponseredFPC = await getDeployedSponsoredFPCAddress(pxe);
    const sponsoredPaymentMethod = new SponsoredFeePaymentMethod(deployedSponseredFPC);

    // generate random accounts
    const randomAccountManagers = await Promise.all(
        (await generateSchnorrAccounts(5)).map(
            a => getSchnorrAccount(pxe, a.secret, a.signingKey, a.salt)
        )
    );
    // get corresponding wallets
    const randomWallets = await Promise.all(randomAccountManagers.map(am => am.getWallet()));
    // get corresponding addresses
    const randomAddresses = await Promise.all(randomWallets.map(async w => (await w.getCompleteAddress()).address));

    // create default ethereum clients
    const nodeInfo = await pxe.getNodeInfo();
    const chain = createEthereumChain(['http://localhost:8545'], nodeInfo.l1ChainId);
    const DefaultMnemonic = 'test test test test test test test test test test test junk';
    const { publicClient, walletClient } = createL1Clients(chain.rpcUrls, DefaultMnemonic, chain.chainInfo);

    const feeJuiceAddress = nodeInfo.protocolContractAddresses.feeJuice;

    // create portal manager
    const l1PortalManager = await L1FeeJuicePortalManager.new(
        pxe,
        publicClient,
        walletClient,
        logger
    );

    return {sandboxInstance, pxe, l1PortalManager, feeJuiceAddress,randomAddresses, sponsoredPaymentMethod, accounts, wallets,randomWallets , randomAccountManagers}

}

describe("Accounts", () => {
    it("Creates accounts with fee juice", async () => {
        const {sandboxInstance, pxe, l1PortalManager, feeJuiceAddress,randomAddresses, sponsoredPaymentMethod, accounts, wallets,randomWallets , randomAccountManagers} = await setup()
        // balance of each random account is 0 before bridge
        let balances = await Promise.all(randomAddresses.map(async a => getFeeJuiceBalance(a, pxe)));
        balances.forEach(b => expect(b).equals(0n));


        // bridge funds to unfunded random addresses
        const claimAmount = 1000000000000000000n;
        const approxMaxDeployCost = 10n ** 10n; // Need to manually update this if fees increase significantly
        let claims: L2AmountClaim[] = [];
        // bridge sequentially to avoid l1 txs (nonces) being processed out of order
        for (let i = 0; i < randomAddresses.length; i++) {
            claims.push(await l1PortalManager.bridgeTokensPublic(randomAddresses[i], claimAmount, true));
        }

        // arbitrary transactions to progress 2 blocks, and have fee juice on Aztec ready to claim
        await EasyPrivateVotingContract.deploy(wallets[0], accounts[0]).send().deployed(); // deploy contract with first funded wallet
        await EasyPrivateVotingContract.deploy(wallets[0], accounts[0]).send().deployed(); // deploy contract with first funded wallet

        // claim and pay to deploy random accounts
        let sentTxs:any[] = [];
        for (let i = 0; i < randomWallets.length; i++) {
            const paymentMethod = new FeeJuicePaymentMethodWithClaim(randomWallets[i], claims[i]);
            sentTxs.push(randomAccountManagers[i].deploy({ fee: { paymentMethod } }));
        }
        await Promise.all(sentTxs.map(stx => stx.wait()));

        // balance after deploy with claimed fee juice
        balances = await Promise.all(randomAddresses.map(async a => getFeeJuiceBalance(a, pxe)));
        const amountAfterDeploy = claimAmount - approxMaxDeployCost;
        balances.forEach(b => expect(Number(b)).greaterThanOrEqual(Number(amountAfterDeploy)));

        sandboxInstance!.kill('SIGINT');

    });

    it("Deploys first unfunded account from first funded account", async () => {
        const {sandboxInstance, wallets, randomAccountManagers} = await setup()
        const tx_acc = await randomAccountManagers[0].deploy({ deployWallet: wallets[0] });
        sandboxInstance!.kill('SIGINT');
    });

    it("Sponsored contract deployment", async () => {
        const {sandboxInstance, pxe,  sponsoredPaymentMethod} = await setup()

        const salt = Fr.random();
        const VotingContractArtifact = EasyPrivateVotingContractArtifact
        // const [deployerWallet, adminWallet] = wallets; // using first account as deployer and second as contract admin
        const accounts = await Promise.all(
            (await generateSchnorrAccounts(2)).map(
                async a => await getSchnorrAccount(pxe, a.secret, a.signingKey, a.salt)
            )
        );
        await Promise.all(accounts.map(a => a.deploy({ fee: { paymentMethod: sponsoredPaymentMethod } })));
        const daWallets = await Promise.all(accounts.map(a => a.getWallet()));
        const [deployerWallet, adminWallet] = daWallets;
        const [deployerAddress, adminAddress] = daWallets.map(w => w.getAddress());
        // const adminAddress = adminWallet.getCompleteAddress().address;

        const deploymentData = await getContractInstanceFromDeployParams(VotingContractArtifact,
            {
                constructorArgs: [adminAddress],
                salt,
                deployer: deployerWallet.getAddress()
            });
        const deployer = new ContractDeployer(VotingContractArtifact, deployerWallet);
        const tx = deployer.deploy(adminAddress).send({
            contractAddressSalt: salt,
            fee: { paymentMethod: sponsoredPaymentMethod } // without the sponsoredFPC the deployment fails, thus confirming it works
        })
        const receipt = await tx.getReceipt();
        
        expect(receipt.status).equal(TxStatus.PENDING)

        const receiptAfterMined = await tx.wait({ wallet: deployerWallet });
        expect(await pxe.getContractMetadata(deploymentData.address)).to.not.equal(undefined);
        expect(Boolean((await pxe.getContractMetadata(deploymentData.address)).contractInstance)).equal(true);
        expect(receiptAfterMined.status).equal(TxStatus.SUCCESS);
        
        expect(receiptAfterMined.contract.instance.address.toString()).equal(deploymentData.address.toString())

        sandboxInstance!.kill('SIGINT');
    })

});