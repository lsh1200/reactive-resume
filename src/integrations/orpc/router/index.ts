import { aiRouter } from "./ai";
import { authRouter } from "./auth";
import { flagsRouter } from "./flags";
import { googleDocsRouter } from "./google-docs";
import { printerRouter } from "./printer";
import { resumeRouter } from "./resume";
import { statisticsRouter } from "./statistics";
import { storageRouter } from "./storage";

export default {
	ai: aiRouter,
	auth: authRouter,
	flags: flagsRouter,
	resume: resumeRouter,
	storage: storageRouter,
	printer: printerRouter,
	statistics: statisticsRouter,
	googleDocs: googleDocsRouter,
};
